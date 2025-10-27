/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import Peer from 'peerjs';
import { GoogleGenAI, Modality } from "@google/genai";

// --- State Variables ---
let ai; // Will be initialized after API key is provided

// --- Core Application Logic ---
document.addEventListener('DOMContentLoaded', () => {

    // --- DOM Elements ---
    const apiKeyContainer = document.getElementById('api-key-container');
    const apiKeyInput = document.getElementById('api-key-input');
    const saveApiKeyBtn = document.getElementById('save-api-key-btn');
    const apiKeyError = document.getElementById('api-key-error');
    const mainContainer = document.querySelector('main.container');

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
    
    const delaySlider = document.getElementById('delay-slider');
    const delayValueSpan = document.getElementById('delay-value');
    const nameInput = document.getElementById('name-input');
    const localNameTag = document.getElementById('local-name-tag');
    const remoteNameTag = document.getElementById('remote-name-tag');

    const sourceLangSelect = document.getElementById('source-lang');
    const targetLangSelect = document.getElementById('target-lang');

    // --- State Variables ---
    let isMeetingActive = false;
    let sessionPromise = null;
    let mediaStream = null;
    let audioContext = null;
    let scriptProcessor = null;
    let translationDelay = 2000;
    let peer = null;
    let dataConnection = null;
    let meetingId = null;
    let localName = 'User 1';
    let remoteName = 'Participant';

    let localTranscriptionBuffer = '';
    let localTranscriptionTimer = null;

    // --- App Initialization ---
    initializeApp();

    // --- Event Listeners ---
    saveApiKeyBtn.addEventListener('click', handleApiKeySave);
    createMeetingBtn.addEventListener('click', createMeeting);
    joinMeetingBtn.addEventListener('click', joinMeeting);
    endMeetingBtn.addEventListener('click', endMeeting);
    copyIdBtn.addEventListener('click', copyInvitationLink);

    delaySlider.addEventListener('input', (e) => {
        translationDelay = parseInt(e.target.value, 10);
        delayValueSpan.textContent = `${(translationDelay / 1000).toFixed(1)}s`;
    });
    nameInput.addEventListener('input', () => {
        localName = nameInput.value.trim() || 'User';
        localNameTag.textContent = localName;
    });

    // --- Core App Logic ---

    function initializeApp() {
        const savedApiKey = localStorage.getItem('gemini_api_key');
        if (savedApiKey) {
            apiKeyInput.value = savedApiKey;
            handleApiKeySave();
        }

        const urlParams = new URLSearchParams(window.location.search);
        const urlMeetingId = urlParams.get('meetingId');
        if (urlMeetingId) {
            meetingIdInput.value = urlMeetingId;
        }

        localName = nameInput.value.trim() || 'User';
        localNameTag.textContent = localName;
        remoteNameTag.textContent = remoteName;
    }

    function handleApiKeySave() {
        const apiKey = apiKeyInput.value.trim();
        if (!apiKey) {
            apiKeyError.style.display = 'block';
            return;
        }
        
        apiKeyError.style.display = 'none';
        
        try {
            ai = new GoogleGenAI({ apiKey });
            localStorage.setItem('gemini_api_key', apiKey);
            
            apiKeyContainer.style.display = 'none';
            mainContainer.style.display = 'flex';
        } catch (error) {
            console.error("Failed to initialize GoogleGenAI:", error);
            apiKeyError.textContent = "Failed to initialize with this key. Please check the key and try again.";
            apiKeyError.style.display = 'block';
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
            showError("API Key not configured. Please enter your API key first.");
            apiKeyContainer.style.display = 'block';
            mainContainer.style.display = 'none';
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
            setupGeminiTranscription();
            
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

    function endMeeting() {
        // Just reload the page. This is the most reliable way to reset all state
        // (PeerJS connections, media streams, audio contexts, Gemini sessions)
        // and prevent the application from entering a broken, crashed state.
        // It's a clean slate every time.
        window.location.reload();
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
            updateStatus('listening', 'Connected & Listening');
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

    function setupGeminiTranscription() {
        audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        const source = audioContext.createMediaStreamSource(mediaStream);
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

        scriptProcessor.onaudioprocess = (event) => {
          const inputData = event.inputBuffer.getChannelData(0);
          const pcmBlob = createBlob(inputData);
          sessionPromise?.then((session) => {
            session.sendRealtimeInput({ media: pcmBlob });
          });
        };
        source.connect(scriptProcessor);
        scriptProcessor.connect(audioContext.destination);
    }

    function handleLocalTranscription(text) {
        if (!text.trim() && localTranscriptionBuffer.length === 0) return;
        localTranscriptionBuffer += text;

        if (dataConnection?.open) {
            dataConnection.send({ type: 'transcription', text: text });
        }

        if (localTranscriptionTimer) clearTimeout(localTranscriptionTimer);
        
        const lineToTranslate = localTranscriptionBuffer;
        
        localTranscriptionTimer = window.setTimeout(() => {
            appendAndTranslate(lineToTranslate, 'You');
            localTranscriptionBuffer = '';
        }, translationDelay);
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