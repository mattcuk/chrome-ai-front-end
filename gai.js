
// Chat frontend using Chrome Prompt API patterns when available.
const messagesEl = document.getElementById('messages');
const form = document.getElementById('composer');
const input = document.getElementById('input');
const statusEl = document.getElementById('status');
const sendBtn = document.getElementById('sendBtn');
const cancelBtn = document.getElementById('cancelBtn');
const newThreadBtn = document.getElementById('newThreadBtn');

const SYSTEM_PROMPT = "You are a helpful assistant.";
let controller = null;
let session = null;
let isRunning = false;

function appendMessage(role, text){
	const el = document.createElement('div');
	el.className = 'msg ' + (role === 'user' ? 'user' : 'assistant');
	el.innerHTML = `<div class="meta">${role === 'user' ? 'You' : 'Assistant'}</div><div class="body"></div>`;
	el.querySelector('.body').textContent = text;
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

function setStatus(text, busy=false){
	statusEl.textContent = text || '';
	if(busy){
		const s = document.createElement('span'); s.className='spinner';
		statusEl.prepend(s);
	}
}

function mockGenerate(prompt){
	return new Promise(resolve=>{
		setTimeout(()=>resolve(`Echo: ${prompt.slice(0,400)}${prompt.length>400? '…':''}\n\n(This is a local mock response.)`), 800 + Math.random()*800);
	});
}

function startNewThread(){
	// abort any in-flight generation
	try{ controller?.abort(); }catch(e){}
	try{ session?.destroy?.(); }catch(e){}
	session = null;
	// clear messages and re-add assistant starter
	messagesEl.innerHTML = '';
	appendMessage('assistant', 'New thread started. Hello — ask me anything.');
	setStatus('New thread started');
	input.focus();
}

function withTimeout(promise, ms, label){
	const timer = new Promise((_, reject)=> setTimeout(()=> reject(new Error(`${label} timed out after ${ms}ms`)), ms));
	return Promise.race([promise, timer]);
}

async function initAvailability(){
	if(!('LanguageModel' in self)){
		setStatus('Prompt API not supported — using fallback.');
		sendBtn.disabled = false;
		return;
	}
	try{
		setStatus('Checking model availability...', true);
		const availability = await LanguageModel.availability({
            expectedInputs: [{ type: 'text', languages: ['en'] }],
            expectedOutputs: [{ type: 'text', languages: ['en'] }],
        });
		if(availability === 'available'){
			setStatus('Model ready.');
			sendBtn.disabled = false;
		} else if(availability === 'downloadable' || availability === 'downloading'){
			setStatus(`Model status: ${availability}. Please wait for download.`);
			sendBtn.disabled = true;
		} else {
			setStatus('Model unavailable on this device — using fallback.');
			sendBtn.disabled = false;
		}
	}catch(err){
		console.error('availability check failed', err);
		setStatus('Could not check model status — using fallback.');
		sendBtn.disabled = false;
	}
}

async function handleSend(prompt){
	if(isRunning) return;
	isRunning = true;
	appendMessage('user', prompt);
	sendBtn.disabled = true;
	cancelBtn.hidden = false;
	setStatus('Thinking...', true);

	controller = new AbortController();
	let session = null;
	const usePromptAPI = ('LanguageModel' in self);

	try{
		if(usePromptAPI){
			if(!session){
				session = await withTimeout(LanguageModel.create({systemPrompt: SYSTEM_PROMPT, signal: controller.signal}), 30000, 'Session creation');
				setStatus('Conversation session ready.');
			}

			const assistantEl = appendMessage('assistant', '');
			if(typeof session.promptStreaming === 'function'){
				const stream = session.promptStreaming(prompt, {signal: controller.signal});
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
			} else if(typeof session.prompt === 'function'){
				const res = await session.prompt(prompt, {signal: controller.signal});
				assistantEl.querySelector('.body').innerHTML = renderMarkdown(String(res));
			} else {
				const res = await session.prompt(prompt);
				assistantEl.querySelector('.body').innerHTML = renderMarkdown(String(res));
			}

			setStatus(`Ready — conversation preserved.`);
		} else {
			// fallback mock
			const assistantEl = appendMessage('assistant', '');
			const text = await mockGenerate(prompt);
			assistantEl.querySelector('.body').innerHTML = renderMarkdown(text);
			setStatus('Fallback response');
		}
	}catch(err){
		if(err.name === 'AbortError'){
			appendMessage('assistant', '[Generation cancelled]');
			setStatus('Cancelled');
		} else {
			console.error('Generation failed', err);
			appendMessage('assistant', 'Error generating response — check console.');
			setStatus('Error');
		}
	}finally{
		controller = null;
		isRunning = false;
		sendBtn.disabled = false;
		cancelBtn.hidden = true;
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

appendMessage('assistant', 'Hello — ask me anything. This will use Chrome\'s built-in local \'Nano\' LLM when available.');
initAvailability();
