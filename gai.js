
// Chat frontend using Chrome Prompt API patterns when available.
const messagesEl = document.getElementById('messages');
const form = document.getElementById('composer');
const input = document.getElementById('input');
const statusEl = document.getElementById('status');
const sendBtn = document.getElementById('sendBtn');
const cancelBtn = document.getElementById('cancelBtn');

const SYSTEM_PROMPT = "You are a helpful assistant.";
let controller = null;
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
            // ⚠️ Always pass the same options to the `availability()` function that
            // you use in `prompt()` or `promptStreaming()`. This is critical to
            // align model language and modality capabilities.
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
			session = await withTimeout(LanguageModel.create({systemPrompt: SYSTEM_PROMPT, signal: controller.signal}), 30000, 'Session creation');

			const tokenCount = await session.countPromptTokens(prompt);
			if(tokenCount > session.tokensLeft){
				appendMessage('assistant', 'Input exceeds token budget. Please shorten your message.');
				return;
			}

			// create assistant placeholder and stream into it if supported
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
						assistantEl.querySelector('.body').textContent = accumulated;
					} else {
						assistantEl.querySelector('.body').textContent = chunk;
						accumulated = chunk;
					}
					messagesEl.scrollTop = messagesEl.scrollHeight;
				}
			} else if(typeof session.prompt === 'function'){
				const res = await session.prompt(prompt, {signal: controller.signal});
				assistantEl.querySelector('.body').textContent = String(res);
			} else {
				// unknown session interface
				const res = await session.prompt(prompt);
				appendMessage('assistant', String(res));
			}

			setStatus(`Tokens used: ${session.tokensSoFar} / ${session.maxTokens}`);
		} else {
			// fallback mock
			const assistantEl = appendMessage('assistant', '');
			const text = await mockGenerate(prompt);
			assistantEl.querySelector('.body').textContent = text;
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
		try{ if(session) session.destroy(); }catch(e){console.warn('destroy failed', e)}
		controller = null;
		isRunning = false;
		sendBtn.disabled = false;
		cancelBtn.hidden = true;
	}
}

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

appendMessage('assistant', 'Hello — ask me anything. This demo will use Chrome\'s built-in LLM when available.');
initAvailability();
