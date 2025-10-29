


/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import Peer from 'peerjs';
import { GoogleGenAI, Modality } from "@google/genai";

// --- State Variables ---
let ai;
const API_KEY_STORAGE_KEY = 'googleAiApiKey';

// --- Core Application Logic ---
document.addEventListener('DOMContentLoaded', () => {
    console.log("v3: Push-to-talk enabled."); // Force cache update

    // --- DOM Elements ---
    const apiKeySection = document.getElementById('api-key-section');
    const apiKeyInput = document.getElementById('api-key-input');
    const setApiKeyBtn = document.getElementById('set-api-key-btn');
    const apiKeyError = document.getElementById('api-key-error');
    const mainContainer = document.getElementById('main-container');

    const setupControls = document.getElementById('setup-controls');
    const callInProgressControls = document.getElementById('call-in-progress-controls');
    const createMeetingBtn = document.getElementById('create-meeting-btn');
    const joinMeetingBtn = document.getElementById('join-meeting-btn');
    const endMeetingBtn = document.getElementById('end-meeting-btn');
    const meetingIdInput = document.getElementById('meeting-id-input');
    const meetingInfoContainer = document.getElementById('meeting-info-container');
    const meetingIdDisplay = document.getElementById('meeting-id-display');
    const copyIdBtn = document.getElementById('copy-id-btn');

    const statusIndicator = document.getElementById('status');
    const statusText = statusIndicator.querySelector('.status-text');
    const transcriptionPanel = document.getElementById('transcription-panel');
    const errorContainer = document.getElementById('error-container');
    
    const localParticipant = document.getElementById('local-participant');
    const remoteParticipant = document.getElementById('remote-participant');
    const userVideo = document.getElementById('user-video');
    const remoteVideo = document.getElementById('remote-video');
    
    const talkBtn = document.getElementById('talk-btn');
    const nameInput = document.getElementById('name-input');
    const localNameTag = document.getElementById('local-name-tag');
    const remoteNameTag = document.getElementById('remote-name-tag');

    const sourceLangSelect = document.getElementById('source-lang');
    const targetLangSelect = document.getElementById('target-lang');

    // --- State Variables ---
    let isMeetingActive = false;
    let isTalking = false;
    let sessionPromise = null;
    let mediaStream = null;
    let audioContext = null;
    let audioSourceNode = null;
    let scriptProcessor = null;
    let peer = null;
    let dataConnection = null;
    let meetingId = null;
    let localName = 'Conbello Textile';
    let remoteName = 'Participant';

    let localTranscriptionBuffer = '';
    
    // --- App Initialization ---
    initializeApp();

    // --- Event Listeners ---
    setApiKeyBtn.addEventListener('click', handleApiKeySubmit);
    apiKeyInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            handleApiKeySubmit();
        }
    });
   
    createMeetingBtn.addEventListener('click', createMeeting);
    joinMeetingBtn.addEventListener('click', joinMeeting);
    endMeetingBtn.addEventListener('click', endMeeting);
    copyIdBtn.addEventListener('click', copyInvitationLink);

    nameInput.addEventListener('input', () => {
        localName = nameInput.value.trim() || 'Conbello Textile';
        localNameTag.textContent = localName;
    });

    // Push-to-Talk Listeners
    talkBtn.addEventListener('mousedown', startTranscribing);
    talkBtn.addEventListener('mouseup', stopTranscribing);
    talkBtn.addEventListener('mouseleave', stopTranscribing); // In case mouse slides off
    talkBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startTranscribing(); }, { passive: false });
    talkBtn.addEventListener('touchend', (e) => { e.preventDefault(); stopTranscribing(); });
    
    window.addEventListener('keydown', (e) => {
        if (e.code === 'Space' && !e.repeat && isMeetingActive) {
            e.preventDefault();
            startTranscribing();
        }
    });
    window.addEventListener('keyup', (e) => {
        if (e.code === 'Space' && isMeetingActive) {
            e.preventDefault();
            stopTranscribing();
        }
    });


    // --- Core App Logic ---

    function initializeApp() {
        const savedApiKey = localStorage.getItem(API_KEY_STORAGE_KEY);
        
        if (savedApiKey) {
            initializeAi(savedApiKey);
        } else {
            apiKeySection.style.display = 'block';
            mainContainer.style.display = 'none';
        }

        const urlParams = new URLSearchParams(window.location.search);
        const urlMeetingId = urlParams.get('meetingId');
        if (urlMeetingId) {
            meetingIdInput.value = urlMeetingId;
        }

        localName = nameInput.value.trim() || 'Conbello Textile';
        localNameTag.textContent = localName;
        remoteNameTag.textContent = remoteName;
    }

    function handleApiKeySubmit() {
        const apiKey = apiKeyInput.value.trim();
        if (apiKey) {
            initializeAi(apiKey, true); // Pass true to indicate it's from user input
        } else {
            apiKeyError.textContent = "Please enter a valid API key.";
            apiKeyError.style.display = 'block';
        }
    }

    function initializeAi(apiKey, fromUserInput = false) {
        try {
            ai = new GoogleGenAI({ apiKey: apiKey });
            apiKeySection.style.display = 'none';
            mainContainer.style.display = 'flex';
            apiKeyError.style.display = 'none';

            if (fromUserInput) {
                localStorage.setItem(API_KEY_STORAGE_KEY, apiKey);
            }
        } catch(e) {
            console.error("Failed to initialize GoogleGenAI:", e);
            localStorage.removeItem(API_KEY_STORAGE_KEY);
            apiKeyError.textContent = "Failed to initialize. The API Key might be invalid.";
            apiKeyError.style.display = 'block';
            apiKeySection.style.display = 'block';
            mainContainer.style.display = 'none';
        }
    }
    
    function getSystemInstruction() {
        const sourceLang = sourceLangSelect.value;
        const targetLang = targetLangSelect.value;
        return `You are a machine translation service. Your ONLY function is to translate text between ${sourceLang} and ${targetLang}.
- Detect the source language of the input text.
- Provide a direct translation into the other language.
- Your output MUST contain ONLY the translated text and nothing else.
- Do NOT add any greetings, explanations, apologies, or any text that is not the direct translation.`;
    }

    function createMeeting() {
        meetingId = crypto.randomUUID();
        startMeeting(false); // isJoining = false
    }

    function joinMeeting() {
        const id = meetingIdInput.value.trim();
        if (!id) {
            showError("Please enter a valid Meeting ID.");
            return;
        }
        meetingId = id;
        startMeeting(true); // isJoining = true
    }

    async function startMeeting(isJoining) {
        if (!ai) {
            showError("Application is not initialized. Please provide an API Key.");
            return;
        }

        setLoadingState(true, 'Starting...');
        hideError();
        transcriptionPanel.innerHTML = '';
        setupControls.style.display = 'none';

        try {
            mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
            localParticipant.querySelector('.placeholder').style.display = 'none';
            userVideo.style.display = 'block';
            userVideo.srcObject = mediaStream;

            initializePeer(isJoining);
            await setupGeminiTranscription();
            
            isMeetingActive = true;
            callInProgressControls.style.display = 'flex';
            setLoadingState(false);
            
        } catch (error) {
            console.error(error);
            const errorMessage = error instanceof Error && error.name === 'NotAllowedError'
                ? 'Camera and microphone access was denied.'
                : 'Failed to start. Check permissions and try again.';
            showError(errorMessage);
            endMeeting();
        }
    }
    
    function resetApplicationState() {
        isMeetingActive = false;

        // Stop media streams
        if (mediaStream) {
            mediaStream.getTracks().forEach(track => track.stop());
            mediaStream = null;
        }

        // Disconnect audio processing
        if (scriptProcessor) {
            scriptProcessor.disconnect();
            scriptProcessor = null;
            audioSourceNode = null;
        }
        if (audioContext && audioContext.state !== 'closed') {
             audioContext.close().catch(e => console.error("Error closing AudioContext:", e));
        }
        audioContext = null;


        // Close Gemini session
        if (sessionPromise) {
            sessionPromise.then(session => session.close()).catch(e => console.error("Error closing session:", e));
            sessionPromise = null;
        }
        
        // Close data connection
        if (dataConnection) {
            dataConnection.close();
            dataConnection = null;
        }

        // Destroy PeerJS connection
        if (peer && !peer.destroyed) {
            peer.destroy();
        }
        peer = null;

        // Reset UI elements
        setupControls.style.display = 'flex';
        callInProgressControls.style.display = 'none';
        meetingInfoContainer.style.display = 'none';

        userVideo.srcObject = null;
        userVideo.style.display = 'none';
        localParticipant.querySelector('.placeholder').style.display = 'flex';

        remoteVideo.srcObject = null;
        remoteVideo.style.display = 'none';
        remoteParticipant.querySelector('.placeholder').style.display = 'flex';
        remoteParticipant.querySelector('.placeholder p').textContent = 'Waiting for participant to join...';

        transcriptionPanel.innerHTML = '';
        meetingIdDisplay.textContent = '';
        const urlParams = new URLSearchParams(window.location.search);
        if (!urlParams.has('meetingId')) {
            meetingIdInput.value = '';
        }

        // Reset state variables
        meetingId = null;
        localTranscriptionBuffer = '';
        isTalking = false;
        talkBtn.classList.remove('talking');
        
        remoteName = 'Participant';
        remoteNameTag.textContent = remoteName;

        // Re-enable controls
        setLoadingState(false);
        updateStatus('idle', 'Idle');
    }

    function endMeeting() {
        console.log("Ending meeting and resetting state.");
        resetApplicationState();
    }


    function initializePeer(isJoining) {
        // Use a randomly generated ID for the joining peer to avoid ID conflicts.
        const peerIdToRegister = isJoining ? undefined : meetingId;
        
        const iceServers = {
            'iceServers': [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
            ]
        };

        peer = new Peer(peerIdToRegister, { config: iceServers });
        
        peer.on('open', (id) => {
            if (isJoining) {
                connectToPeer(meetingId);
            } else {
                meetingIdDisplay.textContent = meetingId;
                meetingInfoContainer.style.display = 'flex';
                updateStatus('waiting', 'Waiting for participant...');
            }
        });

        peer.on('call', (call) => {
            call.answer(mediaStream);
            setupRemoteStream(call);
        });

        peer.on('connection', (conn) => {
            dataConnection = conn;
            setupDataConnection();
        });

        peer.on('error', (err) => {
            console.error('PeerJS error:', err);
            let errorMessage = `Connection error. Please try again.`;
            if (err.type === 'peer-unavailable') {
                errorMessage = 'The participant is not available. Please check the Meeting ID.';
            } else if (err.type === 'network') {
                errorMessage = 'Network connection lost. Please check your internet connection.';
            } else if (err.type === 'id-taken') {
                errorMessage = 'This meeting ID is already in use. Please create a new meeting.';
            }
            showError(errorMessage);
            endMeeting();
        });
    }

    function connectToPeer(peerId) {
        if (!peer || !mediaStream) return;
        
        updateStatus('connecting', 'Connecting...');

        const connectionTimeout = setTimeout(() => {
            showError('Connection timed out. The peer may be unavailable or behind a restrictive firewall.');
            endMeeting();
        }, 15000);

        const call = peer.call(peerId, mediaStream);
        setupRemoteStream(call, () => clearTimeout(connectionTimeout));

        dataConnection = peer.connect(peerId);
        setupDataConnection();
    }

    function setupRemoteStream(call, onStreamCallback) {
        call.on('stream', (remoteStream) => {
            if(onStreamCallback) {
                onStreamCallback();
            }
            updateStatus('ready', 'Hold to Talk');
            remoteParticipant.querySelector('.placeholder').style.display = 'none';
            remoteVideo.style.display = 'block';
            remoteVideo.srcObject = remoteStream;
        });

        call.on('close', () => {
            showError('Participant has left the meeting.');
            endMeeting();
        });
    }

    function setupDataConnection() {
        if (!dataConnection) return;
        dataConnection.on('data', (data) => {
            if (data.type === 'transcription') {
                appendAndTranslate(data.text, 'Participant');
            } else if (data.type === 'name') {
                remoteName = data.name;
                remoteNameTag.textContent = remoteName;
            }
        });
        dataConnection.on('open', () => {
            dataConnection.send({ type: 'name', name: localName });
        });
    }

    async function setupGeminiTranscription() {
        audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        audioSourceNode = audioContext.createMediaStreamSource(mediaStream);
        scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);

        sessionPromise = ai.live.connect({
          model: 'gemini-2.5-flash-native-audio-preview-09-2025',
          callbacks: {
            onopen: () => {},
            onmessage: (message) => {
              const text = message.serverContent?.inputTranscription?.text;
              if (text) {
                handleLocalTranscription(text);
              }
            },
            onerror: (e) => showError('Real-time connection error.'),
            onclose: (e) => {},
          },
          config: {
            responseModalities: [Modality.AUDIO],
            inputAudioTranscription: {},
          },
        });
        await sessionPromise; // Ensure session is connected before we allow talking

        scriptProcessor.onaudioprocess = (event) => {
          const inputData = event.inputBuffer.getChannelData(0);
          const pcmBlob = createBlob(inputData);
          sessionPromise?.then((session) => {
            session.sendRealtimeInput({ media: pcmBlob });
          });
        };
        audioSourceNode.connect(scriptProcessor);
        // We disconnect immediately; will be reconnected on push-to-talk
        scriptProcessor.disconnect();
    }

    function startTranscribing() {
        if (!isMeetingActive || isTalking || !scriptProcessor || !audioContext) return;
        isTalking = true;
        talkBtn.classList.add('talking');
        updateStatus('listening', 'Listening...');
        // Connect the processor to start sending audio
        scriptProcessor.connect(audioContext.destination);
    }
    
    function stopTranscribing() {
        if (!isMeetingActive || !isTalking || !scriptProcessor) return;
        isTalking = false;
        talkBtn.classList.remove('talking');
        updateStatus('ready', 'Hold to Talk');
        // Disconnect the processor to stop sending audio
        scriptProcessor.disconnect();

        // If there's any remaining text in the buffer, send it immediately
        if (localTranscriptionBuffer.trim().length > 0) {
            appendAndTranslate(localTranscriptionBuffer, 'You');
            if (dataConnection?.open) {
                dataConnection.send({ type: 'transcription', text: localTranscriptionBuffer });
            }
            localTranscriptionBuffer = '';
        }
    }


    function handleLocalTranscription(text) {
        if (!isTalking) return; // Ignore transcription if not actively talking
        localTranscriptionBuffer += text;
    }

    async function appendAndTranslate(text, speaker) {
        const lineEl = document.createElement('div');
        lineEl.className = 'transcription-line';

        const speakerSpan = document.createElement('span');
        speakerSpan.className = 'speaker';
        speakerSpan.textContent = `${speaker === 'You' ? localName : remoteName}:`;

        const originalTextSpan = document.createElement('span');
        originalTextSpan.className = 'original-text';
        originalTextSpan.textContent = text;
        
        const translatedTextSpan = document.createElement('span');
        translatedTextSpan.className = 'translated-text';
        translatedTextSpan.textContent = 'Translating...';

        lineEl.appendChild(speakerSpan);
        lineEl.appendChild(originalTextSpan);
        lineEl.appendChild(translatedTextSpan);
        transcriptionPanel.appendChild(lineEl);
        transcriptionPanel.scrollTop = transcriptionPanel.scrollHeight;

        try {
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: [{ parts: [{ text: text }] }],
                config: { systemInstruction: getSystemInstruction() }
            });
            const translation = response.text;
            translatedTextSpan.textContent = translation ? translation.trim() : '[No Translation]';
        } catch (e) {
            console.error("Translation API failed:", e);
            translatedTextSpan.textContent = '[Translation Error]';
        }
    }


    function setLoadingState(isLoading, loadingText = 'Connecting...') {
        createMeetingBtn.disabled = isLoading;
        joinMeetingBtn.disabled = isLoading;
        nameInput.disabled = isLoading || isMeetingActive;
        meetingIdInput.disabled = isLoading || isMeetingActive;
        
        if (isLoading) {
             const originalText = isMeetingActive ? "Ending..." : loadingText;
             endMeetingBtn.textContent = originalText;
             endMeetingBtn.disabled = true;
        } else {
             endMeetingBtn.textContent = "End Meeting";
             endMeetingBtn.disabled = false;
        }
    }

    function updateStatus(status, text) {
        statusIndicator.dataset.status = status;
        statusText.textContent = text;
    }

    function copyInvitationLink() {
        if (!meetingId) return;

        let invitationText;
        let alertMessage;

        // Create a full, shareable URL if the app is hosted on a web server.
        if (window.location.protocol.startsWith('http')) {
            const url = new URL(window.location.href);
            url.searchParams.set('meetingId', meetingId);
            invitationText = url.toString();
            alertMessage = `Invitation Link Copied!\n\n${invitationText}\n\nSend this link to the other participant to join.`;
        } else {
            // Fallback to copying just the ID if running from a local file.
            invitationText = meetingId;
            alertMessage = `Meeting ID Copied: ${meetingId}\n\nThe app is running from a local file, so a shareable link cannot be created. Please send this ID to the other participant. They can paste it into the 'Meeting ID' field to join.`;
        }

        navigator.clipboard.writeText(invitationText).then(() => {
            copyIdBtn.textContent = 'Copied!';
            copyIdBtn.classList.add('copied');
            
            alert(alertMessage);

            setTimeout(() => {
                copyIdBtn.textContent = 'Copy Invitation Link';
                copyIdBtn.classList.remove('copied');
            }, 3000);
        }).catch(err => {
            console.error('Failed to copy invitation: ', err);
            showError('Could not copy invitation to clipboard.');
        });
    }

    function showError(message) {
        errorContainer.textContent = message;
        errorContainer.style.display = 'block';
        updateStatus('error', 'Error');
    }

    function hideError() {
        errorContainer.style.display = 'none';
    }

    function encode(bytes) {
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    function createBlob(data) {
        const int16 = new Int16Array(data.length);
        for (let i = 0; i < data.length; i++) {
            int16[i] = data[i] * 32768;
        }
        return {
            data: encode(new Uint8Array(int16.buffer)),
            mimeType: 'audio/pcm;rate=16000',
        };
    }
});