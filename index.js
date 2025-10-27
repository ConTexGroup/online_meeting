
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import Peer from 'peerjs';
import { GoogleGenAI, Modality } from "@google/genai";

// --- State Variables ---
let ai = null; // Declare ai, but initialize lazily

// Function to get the AI instance, creating it if it doesn't exist.
// This prevents startup errors from blocking the UI.
function getAiInstance() {
    if (!ai) {
        ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    }
    return ai;
}
// --- Core Application Logic ---
document.addEventListener('DOMContentLoaded', () => {

    // --- DOM Elements ---
    const setupControls = document.getElementById('setup-controls');
    const callInProgressControls = document.getElementById('call-in-progress-controls');
    const createMeetingBtn = document.getElementById('create-meeting-btn');
    const joinMeetingBtn = document.getElementById('join-meeting-btn');
    const endMeetingBtn = document.getElementById('end-meeting-btn');
    const meetingIdInput = document.getElementById('meeting-id-input');
    const meetingInfoContainer = document.getElementById('meeting-info-container');
    const meetingIdDisplay = document.getElementById('meeting-id-display');
    const copyIdBtn = document.getElementById('copy-id-btn');
    const toggleMicBtn = document.getElementById('toggle-mic-btn');
    const toggleCameraBtn = document.getElementById('toggle-camera-btn');

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
    let isTranscriptionSetup = false;
    let sessionPromise = null;
    let mediaStream = null; // Original stream from getUserMedia
    let peerStream = null; // Processed stream for PeerJS
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
    // Check for meeting ID in URL and set up initial names
    const urlParams = new URLSearchParams(window.location.search);
    const urlMeetingId = urlParams.get('meetingId');
    if (urlMeetingId) {
        meetingIdInput.value = urlMeetingId;
    }

    localName = nameInput.value.trim() || 'User';
    localNameTag.textContent = localName;
    remoteNameTag.textContent = remoteName;


    // --- Event Listeners ---
    createMeetingBtn.addEventListener('click', createMeeting);
    joinMeetingBtn.addEventListener('click', joinMeeting);
    endMeetingBtn.addEventListener('click', endMeeting);
    copyIdBtn.addEventListener('click', copyInvitationLink);
    toggleMicBtn.addEventListener('click', toggleMicrophone);
    toggleCameraBtn.addEventListener('click', toggleCamera);


    delaySlider.addEventListener('input', (e) => {
        translationDelay = parseInt(e.target.value, 10);
        delayValueSpan.textContent = `${(translationDelay / 1000).toFixed(1)}s`;
    });
    nameInput.addEventListener('input', () => {
        localName = nameInput.value.trim() || 'User';
        localNameTag.textContent = localName;
    });

    // --- Core App Logic ---
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
        setLoadingState(true, 'Starting...');
        hideError();
        transcriptionPanel.innerHTML = '';
        setupControls.style.display = 'none';

        try {
            // STEP 1: Request permissions and get media stream. This is the new entry point.
            mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
            
            // Show the user their own video immediately as feedback.
            localParticipant.querySelector('.placeholder').style.display = 'none';
            userVideo.style.display = 'block';
            userVideo.srcObject = mediaStream;


            // STEP 2: Build the Web Audio API pipeline.
            // THIS IS THE KEY FIX: Initialize the AudioContext at the target sample rate required by Gemini.
            // This prevents risky real-time resampling and resolves the hardware resource conflict.
            const targetSampleRate = 16000;
            audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: targetSampleRate });
            
            if (audioContext.state === 'suspended') {
                await audioContext.resume();
            }

            const sourceNode = audioContext.createMediaStreamSource(mediaStream);
            const peerDestinationNode = audioContext.createMediaStreamAudioDestinationNode();
            scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);

            scriptProcessor.onaudioprocess = (event) => {
                if (!sessionPromise) return; // Don't process until Gemini is ready.
                const inputData = event.inputBuffer.getChannelData(0);
                // The resampleBuffer function will now correctly identify that the sample rate already matches
                // and will pass the data through without expensive processing.
                const resampledData = resampleBuffer(inputData, targetSampleRate);
                const pcmBlob = createBlob(resampledData);
                sessionPromise.then((session) => {
                    if (session) {
                        session.sendRealtimeInput({ media: pcmBlob });
                    }
                }).catch(e => {
                     console.error("Error sending audio data:", e);
                });
            };

            // Connect the audio graph: Mic Source -> Gemini Processor -> PeerJS Destination
            sourceNode.connect(scriptProcessor);
            scriptProcessor.connect(peerDestinationNode);
            // Connect processor to main output to prevent it from being garbage-collected.
            scriptProcessor.connect(audioContext.destination);

            // Create the final stream for PeerJS by combining video and the processed audio.
            const videoTracks = mediaStream.getVideoTracks();
            peerStream = new MediaStream([
                ...videoTracks,
                peerDestinationNode.stream.getAudioTracks()[0]
            ]);


            // STEP 3: Initialize PeerJS with the clean, processed stream.
            initializePeer(isJoining);

            isMeetingActive = true;
            callInProgressControls.style.display = 'flex';
            setLoadingState(false);
            
        } catch (error) {
            console.error("Error during meeting start:", error);
            let errorMessage = "Failed to start. Check permissions and try again.";
            if (error.name === 'NotAllowedError') {
                 errorMessage = 'Permission denied. Please allow camera and microphone access to start a meeting.';
            }
            showError(errorMessage);
            endMeeting();
        }
    }

    function endMeeting() {
        if (!isMeetingActive && !mediaStream) return; // Prevent multiple calls

        console.log("Ending meeting...");

        // Stop media tracks
        if (mediaStream) {
            mediaStream.getTracks().forEach(track => track.stop());
            mediaStream = null;
        }
        peerStream = null;

        // Close Gemini session
        if (sessionPromise) {
            sessionPromise.then(session => {
                if (session) session.close();
            }).catch(e => console.error("Error closing Gemini session:", e));
            sessionPromise = null;
        }
        isTranscriptionSetup = false;

        // Stop audio processing
        if (scriptProcessor) {
            scriptProcessor.disconnect();
            scriptProcessor.onaudioprocess = null;
            scriptProcessor = null;
        }
        if (audioContext && audioContext.state !== 'closed') {
            audioContext.close().catch(e => console.error("Error closing AudioContext:", e));
            audioContext = null;
        }

        // Disconnect PeerJS
        if (dataConnection) {
            dataConnection.close();
            dataConnection = null;
        }
        if (peer) {
            peer.destroy();
            peer = null;
        }

        isMeetingActive = false;
        resetUI();
    }
    
    function resetUI() {
        // Hide in-progress controls and show setup controls
        callInProgressControls.style.display = 'none';
        meetingInfoContainer.style.display = 'none';
        setupControls.style.display = 'flex';

        // Reset video elements
        userVideo.srcObject = null;
        remoteVideo.srcObject = null;
        userVideo.style.display = 'none';
        remoteVideo.style.display = 'none';
        localParticipant.querySelector('.placeholder').style.display = 'flex';
        remoteParticipant.querySelector('.placeholder').style.display = 'flex';
        
        // Clear transcription panel and error messages
        transcriptionPanel.innerHTML = '';
        hideError();

        // Reset meeting ID fields
        meetingIdDisplay.textContent = '';
        meetingIdInput.value = '';

        // Reset status indicator
        updateStatus('idle', 'Idle');
        
        // Re-enable inputs
        nameInput.disabled = false;
        meetingIdInput.disabled = false;
        
        // Reset button states
        setLoadingState(false);
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
            call.answer(peerStream); // Use the dedicated PeerJS stream from the audio pipeline
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
        if (!peer || !peerStream) return;
        
        updateStatus('connecting', 'Connecting...');

        const connectionTimeout = setTimeout(() => {
            showError('Connection timed out. The peer may be unavailable or behind a restrictive firewall.');
            endMeeting();
        }, 15000);

        const call = peer.call(peerId, peerStream); // Use the dedicated PeerJS stream
        setupRemoteStream(call, () => clearTimeout(connectionTimeout));

        dataConnection = peer.connect(peerId);
        setupDataConnection();
    }

    function setupRemoteStream(call, onStreamCallback) {
        call.on('stream', (remoteStream) => {
            if(onStreamCallback) {
                onStreamCallback();
            }
            updateStatus('connected', 'Connected. Initializing transcription...');
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
        
        // This 'open' event is a reliable indicator that a two-way connection is established.
        // It's the perfect time to initialize the Gemini transcription service.
        dataConnection.on('open', () => {
            if (!isTranscriptionSetup) {
                // STEP 4: Initialize Gemini only after PeerJS connection is stable.
                setupGeminiTranscription().catch(error => {
                    console.error("Gemini setup failed after connection:", error);
                    showError("Peer connection successful, but real-time transcription failed to start.");
                    updateStatus('error', 'Transcription Error');
                });
            }
            dataConnection.send({ type: 'name', name: localName });
        });
    }
    
    function resampleBuffer(inputBuffer, targetSampleRate) {
        if (!audioContext) return inputBuffer; // Should not happen
        const inputSampleRate = audioContext.sampleRate;
        if (inputSampleRate === targetSampleRate) {
            return inputBuffer;
        }
        const sampleRateRatio = inputSampleRate / targetSampleRate;
        const newLength = Math.round(inputBuffer.length / sampleRateRatio);
        const result = new Float32Array(newLength);
        let offsetResult = 0;
        let offsetBuffer = 0;
        while (offsetResult < result.length) {
            const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
            let accum = 0;
            let count = 0;
            for (let i = offsetBuffer; i < nextOffsetBuffer && i < inputBuffer.length; i++) {
                accum += inputBuffer[i];
                count++;
            }
            result[offsetResult] = accum / count;
            offsetResult++;
            offsetBuffer = nextOffsetBuffer;
        }
        return result;
    }


    async function setupGeminiTranscription() {
        if (isTranscriptionSetup) return;
        isTranscriptionSetup = true;

        updateStatus('connecting', 'Initializing transcription...');
        const genAI = getAiInstance();

        // The AudioContext and ScriptProcessor are already running.
        // We just establish the Gemini connection. The `onaudioprocess`
        // handler will automatically start sending data once `sessionPromise` resolves.
        sessionPromise = genAI.live.connect({
          model: 'gemini-2.5-flash-native-audio-preview-09-2025',
          callbacks: {
            onopen: () => {
               updateStatus('listening', 'Connected & Listening');
            },
            onmessage: (message) => {
              const text = message.serverContent?.inputTranscription?.text;
              if (text) {
                handleLocalTranscription(text);
              }
            },
            onerror: (e) => {
                console.error("Gemini connection error:", e);
                showError('Real-time connection error.');
                updateStatus('error', 'Connection Error');
            },
            onclose: (e) => {},
          },
          config: {
            responseModalities: [Modality.AUDIO],
            inputAudioTranscription: {},
          },
        });

        // Await the promise to catch immediate connection errors.
        await sessionPromise;
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
            const genAI = getAiInstance();
            const response = await genAI.models.generateContent({
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

    function toggleMicrophone() {
        if (!mediaStream) return;
        const audioTracks = mediaStream.getAudioTracks();
        if (audioTracks.length === 0) return;

        audioTracks.forEach(track => {
            track.enabled = !track.enabled;
            if (track.enabled) {
                toggleMicBtn.textContent = 'Mute Mic';
                toggleMicBtn.classList.remove('muted');
            } else {
                toggleMicBtn.textContent = 'Unmute Mic';
                toggleMicBtn.classList.add('muted');
            }
        });
    }

    function toggleCamera() {
        if (!mediaStream) return;
        const videoTracks = mediaStream.getVideoTracks();
        if (videoTracks.length === 0) return;

        videoTracks.forEach(track => {
            track.enabled = !track.enabled;
            if (track.enabled) {
                toggleCameraBtn.textContent = 'Turn Off Camera';
                toggleCameraBtn.classList.remove('muted');
                localParticipant.querySelector('.placeholder').style.display = 'none';
                userVideo.style.display = 'block';
            } else {
                toggleCameraBtn.textContent = 'Turn On Camera';
                toggleCameraBtn.classList.add('muted');
                localParticipant.querySelector('.placeholder').style.display = 'flex';
                userVideo.style.display = 'none';
            }
        });
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