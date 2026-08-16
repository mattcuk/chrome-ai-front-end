
// Chat frontend using Chrome Prompt API patterns when available.
const messagesEl = document.getElementById('messages');
const form = document.getElementById('composer');
const input = document.getElementById('input');
const statusEl = document.getElementById('status');
const sendBtn = document.getElementById('sendBtn');
const cancelBtn = document.getElementById('cancelBtn');
const newThreadBtn = document.getElementById('newThreadBtn');
const threadsEl = document.getElementById('threads');
const settingsBtn = document.getElementById('settingsBtn');
const settingsModal = document.getElementById('settingsModal');
const closeSettingsBtn = document.getElementById('closeSettingsBtn');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const resetSettingsBtn = document.getElementById('resetSettingsBtn');
const systemPromptInput = document.getElementById('systemPromptInput');
const infoBtn = document.getElementById('infoBtn');
const infoModal = document.getElementById('infoModal');
const closeInfoBtn = document.getElementById('closeInfoBtn');

const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.';
let systemPrompt = DEFAULT_SYSTEM_PROMPT;
let controller = null;
let session = null;
let isRunning = false;
let db = null;
let currentConversationId = null;
let modelStatusTimer = null;
const transientConvs = {};

function appendMessage(role, text){
	const el = document.createElement('div');
	el.className = 'msg ' + (role === 'user' ? 'user' : 'assistant');
	const avatar = document.createElement('div'); avatar.className = 'avatar';
	avatar.textContent = role === 'user' ? 'U' : 'A';
	const content = document.createElement('div'); content.className = 'content';
	content.innerHTML = `<div class="meta">${role === 'user' ? 'You' : 'Assistant'} <span class="time">${new Date().toLocaleTimeString()}</span></div><div class="body"></div>`;
	const bodyEl = content.querySelector('.body');
	if(role === 'assistant'){
		bodyEl.innerHTML = renderMarkdown(text);
	} else {
		// user messages are escaped to avoid unintended HTML/markdown rendering
		bodyEl.innerHTML = escapeHtml(String(text)).replace(/\n/g, '<br>');
	}
	el.appendChild(avatar);
	el.appendChild(content);
	messagesEl.appendChild(el);
	messagesEl.scrollTop = messagesEl.scrollHeight;
	return el;
}

function escapeHtml(str){
	return String(str)
	  .replace(/&/g, '&amp;')
	  .replace(/</g, '&lt;')
	  .replace(/>/g, '&gt;')
	  .replace(/"/g, '&quot;')
	  .replace(/'/g, '&#39;');
}

function renderMarkdown(md){
	const text = String(md || '');
	if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
		const html = marked.parse(text);
		return DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'rel'] });
	}
	// Fallback for environments without marked/DOMPurify.
	return escapeHtml(text).replace(/\n/g, '<br>');
}

function setStatus(text, busy=false, progress=null){
	statusEl.replaceChildren();
	const line = document.createElement('div');
	line.className = 'status-line';
	if(busy){
		const s = document.createElement('span'); s.className='spinner';
		line.appendChild(s);
	}
	const label = document.createElement('span');
	label.className = 'status-text';
	label.textContent = text || '';
	line.appendChild(label);
	statusEl.appendChild(line);

	if(progress !== null && Number.isFinite(Number(progress))){
		const pct = Math.max(0, Math.min(100, Number(progress)));
		const track = document.createElement('div');
		track.className = 'status-progress';
		const bar = document.createElement('div');
		bar.className = 'status-progress-bar';
		bar.style.width = `${pct}%`;
		track.appendChild(bar);
		const detail = document.createElement('div');
		detail.className = 'status-progress-label';
		detail.textContent = `Downloading ${Math.round(pct)}%`;
		statusEl.appendChild(track);
		statusEl.appendChild(detail);
	}
}

function mockGenerate(prompt){
	return new Promise(resolve=>{
		setTimeout(()=>resolve(`Echo: ${prompt.slice(0,400)}${prompt.length>400? '…':''}\n\n(This is a local mock response.)`), 800 + Math.random()*800);
	});
}

function withTimeout(promise, ms, label){
	const timer = new Promise((_, reject)=> setTimeout(()=> reject(new Error(`${label} timed out after ${ms}ms`)), ms));
	return Promise.race([promise, timer]);
}

// ---- IndexedDB persistence helpers ----
function openDB(){
	return new Promise((resolve, reject)=>{
		if(!('indexedDB' in window)) return resolve(null);
		const req = indexedDB.open('gai-db', 1);
		req.onupgradeneeded = (e)=>{
			const d = e.target.result;
			if(!d.objectStoreNames.contains('conversations')) d.createObjectStore('conversations', { keyPath: 'id' });
			if(!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
		};
		req.onsuccess = (e)=> resolve(e.target.result);
		req.onerror = (e)=> reject(e.target.error);
	});
}

function idbGet(store, key){
	return new Promise((resolve, reject)=>{
		const tx = db.transaction([store], 'readonly');
		const os = tx.objectStore(store);
		const r = os.get(key);
		r.onsuccess = ()=> resolve(r.result);
		r.onerror = ()=> reject(r.error);
	});
}

function idbPut(store, val){
	return new Promise((resolve, reject)=>{
		const tx = db.transaction([store], 'readwrite');
		const os = tx.objectStore(store);
		const r = os.put(val);
		r.onsuccess = ()=> resolve(r.result);
		r.onerror = ()=> reject(r.error);
	});
}

function idbGetAll(store){
	return new Promise((resolve, reject)=>{
		const tx = db.transaction([store], 'readonly');
		const os = tx.objectStore(store);
		const r = os.getAll();
		r.onsuccess = ()=> resolve(r.result);
		r.onerror = ()=> reject(r.error);
	});
}

function idbDelete(store, key){
	return new Promise((resolve, reject)=>{
		const tx = db.transaction([store], 'readwrite');
		const os = tx.objectStore(store);
		const r = os.delete(key);
		r.onsuccess = ()=> resolve();
		r.onerror = ()=> reject(r.error);
	});
}

async function saveConversation(conv){
	if(db) await idbPut('conversations', conv);
	try{ localStorage.setItem('gai.conv.' + conv.id, JSON.stringify(conv)); }catch(e){}
}

async function loadConversations(){
	let list = [];
	if(db){
		try{ list = await idbGetAll('conversations'); }
		catch(e){ console.warn('idb getAll failed', e); }
	}
	if(!list || list.length === 0){
		// fallback to localStorage scan
		try{
			for(const k in localStorage){
				if(k.startsWith('gai.conv.')){
					const v = JSON.parse(localStorage.getItem(k));
					if(v) list.push(v);
				}
			}
		}catch(e){}
	}
	// sort by updated desc
	list.sort((a,b)=> (b.updated || 0) - (a.updated || 0));
	return list;
}

async function saveMeta(key, value){
	if(db) await idbPut('meta', { key, value });
	try{ localStorage.setItem('gai.meta.'+key, JSON.stringify(value)); }catch(e){}
}

async function getMeta(key){
	if(db){
		try{ const r = await idbGet('meta', key); if(r) return r.value; }catch(e){}
	}
	try{ const l = localStorage.getItem('gai.meta.'+key); return l ? JSON.parse(l) : null; }catch(e){ return null; }
}

function makeId(){ return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,8); }

function renderThreadList(convs){
	threadsEl.innerHTML = '';
	convs.forEach(c => {
		const el = document.createElement('div'); el.className = 'thread' + (c.id===currentConversationId?' active':'');
		const title = document.createElement('div'); title.className='title'; title.textContent = c.title || 'Conversation';
		const preview = document.createElement('div'); preview.className='preview'; preview.textContent = (c.messages && c.messages.length)? c.messages[c.messages.length-1].content.slice(0,120) : '';
		const del = document.createElement('button'); del.className='thread-delete'; del.title='Delete conversation'; del.innerHTML='&times;';
		del.addEventListener('click', (e)=>{ e.stopPropagation(); deleteConversation(c.id); });
		el.appendChild(del);
		el.appendChild(title); el.appendChild(preview);
		el.addEventListener('click', ()=>{ loadConversation(c.id); });
		threadsEl.appendChild(el);
	});
}

async function createConversation(seedText, save=true){
	const id = makeId();
	const conv = { id, title: seedText ? seedText.slice(0,60) : 'New conversation', messages: [], created: Date.now(), updated: Date.now() };
	if(seedText){ conv.messages.push({ role: 'assistant', content: seedText, timestamp: Date.now() }); }
	if(save){
		await saveConversation(conv);
	} else {
		// keep transient in memory until first user message
		transientConvs[id] = conv;
	}
	return conv;
}

async function startNewThread(){
	try{ controller?.abort(); }catch(e){}
	try{ session?.destroy?.(); }catch(e){}
	session = null;
	const conv = await createConversation('New thread started. Ask me anything.', false);
	currentConversationId = conv.id;
	await saveMeta('currentConversationId', conv.id);
	const convs = await loadConversations();
	renderThreadList(convs);
	renderConversation(conv);
	setStatus('New thread started');
	input.focus();
}

async function loadConversation(id){
	let conv = null;
	// check transient in-memory convs first
	if(transientConvs[id]) conv = transientConvs[id];
	if(!conv && db){ try{ conv = await idbGet('conversations', id); }catch(e){}
	}
	if(!conv){ try{ conv = JSON.parse(localStorage.getItem('gai.conv.'+id)); }catch(e){}
	}
	if(!conv) return;
	currentConversationId = conv.id;
	await saveMeta('currentConversationId', conv.id);
	// update thread list active state
	const convs = await loadConversations(); renderThreadList(convs);
	renderConversation(conv);
}

async function deleteConversation(id){
	try{
		if(db){ try{ await idbDelete('conversations', id); }catch(e){ console.warn('idb delete failed', e); } }
		try{ localStorage.removeItem('gai.conv.'+id); }catch(e){}
		const convs = await loadConversations();
		// if current was deleted, switch to another or create a new one
		if(currentConversationId === id){
			if(convs.length > 0){
				currentConversationId = convs[0].id;
				await saveMeta('currentConversationId', currentConversationId);
				await loadConversation(currentConversationId);
			} else {
				const conv = await createConversation('Hello — ask me anything.');
				currentConversationId = conv.id;
				await saveMeta('currentConversationId', currentConversationId);
				renderThreadList(await loadConversations());
				renderConversation(conv);
			}
		} else {
			renderThreadList(convs);
		}
	}catch(e){ console.error('delete failed', e); }
}

function renderConversation(conv){
	messagesEl.innerHTML = '';
	conv.messages.forEach(m => appendMessage(m.role, m.content));
	messagesEl.scrollTop = messagesEl.scrollHeight;
	setStatus(`Ready.`);
}

// Ensure conversation has a helpful title derived from its messages
function ensureConversationTitle(conv){
	if(!conv) return conv;
	if(conv.title && conv.title !== 'New conversation' && !conv.title.startsWith('Hello')) return conv;
	const firstUser = (conv.messages || []).find(m=>m.role==='user');
	const firstAssistant = (conv.messages || []).find(m=>m.role==='assistant');
	const src = firstUser ? firstUser.content : (firstAssistant ? firstAssistant.content : 'Conversation');
	conv.title = (String(src).trim().slice(0,60)) || 'Conversation';
	return conv;
}

async function persistAssistantMessage(content){
	try{
		if(!currentConversationId) return;
		let conv = db ? await idbGet('conversations', currentConversationId) : JSON.parse(localStorage.getItem('gai.conv.'+currentConversationId) || '{}');
		conv.messages = conv.messages || [];
		conv.messages.push({ role: 'assistant', content: content, timestamp: Date.now() });
		conv.updated = Date.now();
		ensureConversationTitle(conv);
		await saveConversation(conv);
		const convs = await loadConversations(); renderThreadList(convs);
	}catch(e){ console.warn('persist assistant msg failed', e); }
}

function normalizeSystemPrompt(value){
	const v = String(value ?? '').trim();
	return v || DEFAULT_SYSTEM_PROMPT;
}

async function initSystemPrompt(){
	const stored = await getMeta('systemPrompt');
	const nextPrompt = normalizeSystemPrompt(stored ?? DEFAULT_SYSTEM_PROMPT);
	systemPrompt = nextPrompt;
	if(!stored || !String(stored).trim()){
		await saveMeta('systemPrompt', systemPrompt);
	}
	if(systemPromptInput) systemPromptInput.value = systemPrompt;
	return systemPrompt;
}

async function saveSystemPrompt(value){
	systemPrompt = normalizeSystemPrompt(value);
	await saveMeta('systemPrompt', systemPrompt);
	if(systemPromptInput) systemPromptInput.value = systemPrompt;
	return systemPrompt;
}

function stopModelStatusPolling(){
	if(modelStatusTimer){
		clearInterval(modelStatusTimer);
		modelStatusTimer = null;
	}
}

async function refreshModelAvailability(){
	if(!('LanguageModel' in self)){
		setStatus('Prompt API not supported — using fallback.');
		sendBtn.disabled = false;
		return true;
	}

	try{
		const availability = await LanguageModel.availability({
			expectedInputs: [{ type: 'text', languages: ['en'] }],
			expectedOutputs: [{ type: 'text', languages: ['en'] }],
		});

		const status = typeof availability === 'string'
			? availability
			: (availability && (availability.status || availability.state || availability.availability)) || 'unavailable';
		const progressValue = (() => {
			if(!availability || typeof availability !== 'object') return null;
			const value = availability.downloadProgress ?? availability.progress ?? availability.percent ?? availability.percentage ?? null;
			if(value === null || value === undefined) return null;
			const num = Number(value);
			return Number.isFinite(num) ? num : null;
		})();
		const percent = progressValue === null ? null : (progressValue <= 1 ? progressValue * 100 : progressValue);

		if(status === 'available'){
			stopModelStatusPolling();
			setStatus('Ready.');
			sendBtn.disabled = false;
			return true;
		}

		if(status === 'downloadable' || status === 'downloading'){
			const label = status === 'downloading'
				? (percent === null ? 'Model is downloading...' : `Model downloading... ${Math.round(percent)}%`)
				: 'Model not installed. Downloading...';
			setStatus(label, true, percent);
			sendBtn.disabled = true;
			return false;
		}

		stopModelStatusPolling();
		setStatus('Model unavailable on this device — using fallback.');
		sendBtn.disabled = false;
		return true;
	}catch(err){
		console.error('availability check failed', err);
		stopModelStatusPolling();
		setStatus('Could not check model status — using fallback.');
		sendBtn.disabled = false;
		return true;
	}
}

async function initAvailability(){
	if(!('LanguageModel' in self)){
		setStatus('Prompt API not supported — using fallback.');
		sendBtn.disabled = false;
		return;
	}

	try{
		setStatus('Checking model availability...', true);
		await refreshModelAvailability();
		if(modelStatusTimer) return;
		modelStatusTimer = setInterval(async ()=>{
			const ready = await refreshModelAvailability();
			if(ready) stopModelStatusPolling();
		}, 2000);
	} catch(err){
		console.error('availability check failed', err);
		setStatus('Could not check model status — using fallback.');
		sendBtn.disabled = false;
	}
}

async function initPersistence(){
	try{ db = await openDB(); }catch(e){ console.warn('IndexedDB open failed', e); db = null; }
	await initSystemPrompt();
	// Always start with a new conversation on page load
	const starterText = 'Hello. Ask me anything. This will use Chrome\'s built-in local \'Nano\' LLM when available.';
	const conv = await createConversation(starterText, false);
	currentConversationId = conv.id;
	await saveMeta('currentConversationId', currentConversationId);
	// still render existing conversations (including the new one)
	const convs = await loadConversations();
	renderThreadList(convs);
	// load the newly created conversation
	await loadConversation(currentConversationId);
}

async function handleSend(prompt){
	if(isRunning) return;
	isRunning = true;
	let finalStatus = 'Ready.';
	appendMessage('user', prompt);
	// persist user message
	try{
		if(!currentConversationId){ const c = await createConversation(); currentConversationId = c.id; }
		let conv = null;
		if(db) conv = await idbGet('conversations', currentConversationId);
		if(!conv) {
			// check transient in-memory conv
			if(transientConvs[currentConversationId]) conv = transientConvs[currentConversationId];
			else conv = JSON.parse(localStorage.getItem('gai.conv.'+currentConversationId) || '{}');
		}
		conv.messages = conv.messages || [];
		const prevFirst = conv.messages.length ? conv.messages[0] : null;
		const prevLen = conv.messages.length;
		const userMsg = { role: 'user', content: prompt, timestamp: Date.now() };
		conv.messages.push(userMsg);
		conv.updated = Date.now();
		// If this is the first user prompt (or the conversation only had the starter assistant message), update the title
		try{
			const starterIndicator = 'New thread started';
			if(prevLen === 0 || (prevLen === 1 && prevFirst && prevFirst.role === 'assistant' && String(prevFirst.content).includes(starterIndicator))){
				conv.title = String(prompt).trim().slice(0,60) || conv.title;
			}
		}catch(e){}
		// If conv was transient (in-memory), persist it now and remove from transient map
		if(transientConvs[currentConversationId]){
			try{
				await saveConversation(conv);
				delete transientConvs[currentConversationId];
			}catch(e){ console.warn('persist transient failed', e); }
		} else {
			await saveConversation(conv);
		}
		const convs = await loadConversations(); renderThreadList(convs);
	}catch(e){ console.warn('persist user msg failed', e); }
	sendBtn.disabled = true;
	cancelBtn.hidden = false;
	setStatus('Thinking...', true);

	controller = new AbortController();
	let session = null;
	const usePromptAPI = ('LanguageModel' in self);

	// build combined prompt including conversation history so historic threads retain context
	let combinedPrompt = prompt;
	try{
		let convForPrompt = null;
		if(db) convForPrompt = await idbGet('conversations', currentConversationId);
		if(!convForPrompt) convForPrompt = JSON.parse(localStorage.getItem('gai.conv.'+currentConversationId) || '{}');
		const msgs = (convForPrompt.messages || []).map(m => (m.role === 'user' ? 'User: ' : 'Assistant: ') + m.content).join('\n');
		combinedPrompt = systemPrompt + '\n\n' + msgs + '\nAssistant:';
	}catch(e){ console.warn('could not build combined prompt', e); }

	try{
		if(usePromptAPI){
			if(!session){
				session = await withTimeout(LanguageModel.create({systemPrompt: systemPrompt, signal: controller.signal}), 30000, 'Session creation');
				setStatus('Chat session ready.');
			}

			const assistantEl = appendMessage('assistant', 'Thinking...');
			assistantEl.querySelector('.body').innerHTML = renderMarkdown('Thinking...');

			setStatus(`Responding...`, true);

			if(typeof session.promptStreaming === 'function'){
				const stream = session.promptStreaming(combinedPrompt, {signal: controller.signal});
				let accumulated = '';
				let isCumulative = null;
				let chunkIndex = 0;
				for await (const chunk of stream){
					chunkIndex++;
					if(chunkIndex === 2){
						isCumulative = chunk.startsWith(accumulated);
					}
					if(isCumulative === false){
						accumulated += chunk;
						assistantEl.querySelector('.body').innerHTML = renderMarkdown(accumulated);
					} else {
						assistantEl.querySelector('.body').innerHTML = renderMarkdown(chunk);
						accumulated = chunk;
					}
					messagesEl.scrollTop = messagesEl.scrollHeight;
				}

				// persist final accumulated response
				try{ await persistAssistantMessage(accumulated); }catch(e){}
			} else if(typeof session.prompt === 'function'){
				const res = await session.prompt(combinedPrompt, {signal: controller.signal});
				assistantEl.querySelector('.body').innerHTML = renderMarkdown(String(res));
				await persistAssistantMessage(String(res));
			} else {
				const res = await session.prompt(combinedPrompt);
				assistantEl.querySelector('.body').innerHTML = renderMarkdown(String(res));
				await persistAssistantMessage(String(res));
			}
		} else {
			// fallback mock
			const assistantEl = appendMessage('assistant', '');
			const text = await mockGenerate(combinedPrompt);
			assistantEl.querySelector('.body').innerHTML = renderMarkdown(text);
			await persistAssistantMessage(text);
			finalStatus = 'Ready.';
		}
	}catch(err){
		if(err.name === 'AbortError'){
			appendMessage('assistant', '[Generation cancelled]');
			finalStatus = 'Cancelled';
		} else {
			console.error('Generation failed', err);
			appendMessage('assistant', 'Error generating response — check console.');
			finalStatus = 'Error';
		}
	}finally{
		controller = null;
		isRunning = false;
		sendBtn.disabled = false;
		cancelBtn.hidden = true;
		setStatus(finalStatus);
	}
}

window.addEventListener('beforeunload', ()=>{
	try{ session?.destroy?.(); }catch(e){ }
});

form.addEventListener('submit', async (e)=>{
	e.preventDefault();
	const txt = input.value.trim();
	if(!txt) return;
	input.value = '';
	await handleSend(txt);
});

input.addEventListener('keydown', (e)=>{
	if(e.key === 'Enter' && !e.shiftKey){
		e.preventDefault();
		form.requestSubmit();
	}
});

cancelBtn.addEventListener('click', ()=>{
	controller?.abort();
});

newThreadBtn?.addEventListener('click', ()=>{
  startNewThread();
});

// Info/settings modal handlers
infoBtn?.addEventListener('click', ()=>{
	if(infoModal) infoModal.hidden = false;
	// prevent body scroll while modal open
	document.body.style.overflow = 'hidden';
});
closeInfoBtn?.addEventListener('click', ()=>{
	if(infoModal) infoModal.hidden = true;
	document.body.style.overflow = '';
});
settingsBtn?.addEventListener('click', ()=>{
	if(systemPromptInput) systemPromptInput.value = systemPrompt;
	if(settingsModal) settingsModal.hidden = false;
	document.body.style.overflow = 'hidden';
});
closeSettingsBtn?.addEventListener('click', ()=>{
	if(settingsModal) settingsModal.hidden = true;
	document.body.style.overflow = '';
});
resetSettingsBtn?.addEventListener('click', ()=>{
	if(systemPromptInput) systemPromptInput.value = DEFAULT_SYSTEM_PROMPT;
});
saveSettingsBtn?.addEventListener('click', async ()=>{
	await saveSystemPrompt(systemPromptInput ? systemPromptInput.value : DEFAULT_SYSTEM_PROMPT);
	if(settingsModal) settingsModal.hidden = true;
	document.body.style.overflow = '';
	setStatus('System prompt saved.');
});
// click overlay to close
infoModal?.addEventListener('click', (e)=>{
	if(e.target === infoModal){ infoModal.hidden = true; document.body.style.overflow = ''; }
});
settingsModal?.addEventListener('click', (e)=>{
	if(e.target === settingsModal){ settingsModal.hidden = true; document.body.style.overflow = ''; }
});
window.addEventListener('keydown', (e)=>{
	if(e.key === 'Escape' && infoModal && !infoModal.hidden){ infoModal.hidden = true; document.body.style.overflow = ''; }
	if(e.key === 'Escape' && settingsModal && !settingsModal.hidden){ settingsModal.hidden = true; document.body.style.overflow = ''; }
});

// Initialize
(async ()=>{ await initAvailability(); await initPersistence(); })();
