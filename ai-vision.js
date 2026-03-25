/* ============================================
   AI VISION MODULE
   Watches match video via Gemini Vision API
   and auto-codes referee events
   ============================================ */

const AI_VISION = {
    apiKey: null,
    isAnalyzing: false,
    abortController: null,
    progress: { current: 0, total: 0 },
    GEMINI_MODEL: 'gemini-2.0-flash',
    GEMINI_URL: 'https://generativelanguage.googleapis.com/v1beta/models/',
    eventsFound: 0,

    // Load saved API key
    loadApiKey() {
        this.apiKey = localStorage.getItem('refanalysis_gemini_key') || null;
        return this.apiKey;
    },

    saveApiKey(key) {
        this.apiKey = key;
        localStorage.setItem('refanalysis_gemini_key', key);
    },

    removeApiKey() {
        this.apiKey = null;
        localStorage.removeItem('refanalysis_gemini_key');
    },

    // === Frame Capture ===

    captureFrame(video, time) {
        return new Promise((resolve) => {
            const canvas = document.createElement('canvas');
            canvas.width = 640;
            canvas.height = 360;

            const seekHandler = () => {
                const ctx = canvas.getContext('2d');
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                video.removeEventListener('seeked', seekHandler);
                const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
                const base64 = dataUrl.split(',')[1];
                resolve(base64);
            };

            video.addEventListener('seeked', seekHandler);
            video.currentTime = time;
        });
    },

    // Capture frames at intervals across the video
    async captureFrames(video, intervalSeconds = 15) {
        const duration = video.duration;
        if (!duration || duration === Infinity) {
            throw new Error('Cannot determine video duration');
        }

        const frames = [];
        const times = [];

        for (let t = 0; t < duration; t += intervalSeconds) {
            times.push(t);
        }

        const wasPaused = video.paused;
        if (!wasPaused) video.pause();

        for (let i = 0; i < times.length; i++) {
            if (this.abortController?.signal.aborted) break;
            this.progress.current = i + 1;
            this.progress.total = times.length;
            updateWatchOverlay('capturing', this.progress);

            const base64 = await this.captureFrame(video, times[i]);
            frames.push({ time: times[i], base64 });
        }

        video.currentTime = 0;
        return frames;
    },

    // === Gemini API ===

    async analyzeFrameBatch(frames, gameContext) {
        const url = `${this.GEMINI_URL}${this.GEMINI_MODEL}:generateContent?key=${this.apiKey}`;

        const parts = [];

        parts.push({
            text: this.buildAnalysisPrompt(gameContext, frames)
        });

        for (const frame of frames) {
            parts.push({
                inlineData: {
                    mimeType: 'image/jpeg',
                    data: frame.base64
                }
            });
            parts.push({
                text: `[Frame at ${formatTime(frame.time)}]`
            });
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: this.abortController?.signal,
            body: JSON.stringify({
                contents: [{ parts }],
                generationConfig: {
                    temperature: 0.2,
                    maxOutputTokens: 4096,
                }
            })
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error?.message || `Gemini API error: ${response.status}`);
        }

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        return text;
    },

    buildAnalysisPrompt(gameContext, frames) {
        const home = gameContext.homeTeam;
        const away = gameContext.awayTeam;
        const format = gameContext.format || '15s';
        const frameTimeList = frames.map(f => formatTime(f.time)).join(', ');

        return `You are an elite rugby union referee video analyst. You are analyzing frames from a ${format} rugby match between ${home} (home) and ${away} (away).

I am sending you ${frames.length} frames captured at these timestamps: ${frameTimeList}

For each frame, analyze what is happening in the match and identify any rugby events visible. Focus on:
- Set pieces (scrums, lineouts, mauls)
- Scoring events (tries, conversions, penalty kicks, drop goals)
- Referee decisions (penalties, free kicks, advantages, cards)
- Breakdowns and rucks
- Kick-offs and restarts
- Infringements (offside, high tackles, not rolling away, obstruction, collapsing)
- Turnovers and knock-ons

For each event you identify, output EXACTLY one line in this format:
MM:SS | event_type | team | zone | notes

Where:
- MM:SS = the timestamp from the frame
- event_type = one of: scrum, lineout, ruck, maul, try, conversion, penalty_kick, drop_goal, kickoff, knock_on, turnover, substitution, penalty, free_kick, advantage, yellow_card, red_card, tmo_review, scrum_penalty, offside, high_tackle, not_rolling_away, obstruction, collapsing
- team = "home" for ${home} or "away" for ${away} (identify by jersey colors if possible)
- zone = own-22, own-half, opp-half, opp-22, or opp-try-line (estimate from field position)
- notes = brief description of what you see

IMPORTANT RULES:
- Only output events you can clearly identify from the frames
- If a frame shows general play with no specific event, skip it
- Do NOT invent events you cannot see
- Look at the scoreboard if visible for score context
- Look at referee signals and positioning
- Identify team jerseys to determine home vs away
- Each line must follow the exact pipe-delimited format
- Output ONLY the event lines, no other text, no headers, no explanations
- If you cannot identify any events from a frame, output nothing for that frame

Begin analysis:`;
    },

    // === Main Analysis Pipeline ===

    async watchAndCode(options = {}) {
        if (this.isAnalyzing) {
            showToast('Analysis already in progress', 'info');
            return;
        }

        if (!this.apiKey) {
            showToast('Please configure your Gemini API key first', 'error');
            return;
        }

        if (!AppState.currentGame) {
            showToast('Please load a game first', 'error');
            return;
        }

        const video = document.getElementById('videoPlayer');
        if (!video || !video.duration || video.duration === Infinity) {
            showToast('Please load a video first', 'error');
            return;
        }

        this.isAnalyzing = true;
        this.eventsFound = 0;
        this.abortController = new AbortController();

        const intervalSeconds = options.interval || 15;
        const batchSize = options.batchSize || 6;

        // Show floating progress overlay
        showWatchOverlay('starting');

        try {
            showToast('Capturing video frames...', 'info');

            // Step 1: Capture frames
            const allFrames = await this.captureFrames(video, intervalSeconds);

            if (this.abortController.signal.aborted) {
                this.cleanup();
                return;
            }

            showToast(`Captured ${allFrames.length} frames. Sending to AI...`, 'info');

            // Step 2: Send frames in batches to Gemini
            const allEvents = [];
            const batches = [];
            for (let i = 0; i < allFrames.length; i += batchSize) {
                batches.push(allFrames.slice(i, i + batchSize));
            }

            const gameContext = {
                homeTeam: AppState.currentGame.homeTeam,
                awayTeam: AppState.currentGame.awayTeam,
                format: AppState.currentGame.format,
            };

            for (let i = 0; i < batches.length; i++) {
                if (this.abortController.signal.aborted) break;

                this.progress.current = i + 1;
                this.progress.total = batches.length;
                updateWatchOverlay('analyzing', this.progress);

                try {
                    const responseText = await this.analyzeFrameBatch(batches[i], gameContext);
                    const events = this.parseAIResponse(responseText);

                    // Add events directly to the Decision Log in real-time
                    for (const evt of events) {
                        await this.addEventToLog(evt);
                        this.eventsFound++;
                        updateWatchOverlay('analyzing', this.progress, this.eventsFound);
                    }

                    allEvents.push(...events);
                } catch (err) {
                    if (err.name === 'AbortError') break;
                    console.error(`Batch ${i + 1} failed:`, err);
                }

                // Small delay between batches to respect rate limits
                if (i < batches.length - 1) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            }

            if (this.abortController.signal.aborted) {
                this.cleanup();
                return;
            }

            if (this.eventsFound > 0) {
                showToast(`AI identified ${this.eventsFound} events and added them to your Decision Log!`, 'success');
            } else {
                showToast('AI could not identify any events from the video frames. Try a shorter interval.', 'info');
            }

            showWatchOverlay('done', null, this.eventsFound);

        } catch (err) {
            if (err.name !== 'AbortError') {
                console.error('AI Vision error:', err);
                showToast(`Analysis failed: ${err.message}`, 'error');
            }
            showWatchOverlay('error', null, 0, err.message);
        } finally {
            this.cleanup();
        }
    },

    // Add a single AI-detected event directly to the Decision Log
    async addEventToLog(evt) {
        const isRef = isRefEvent(evt.type);
        const event = {
            id: `evt_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            gameId: AppState.currentGame.id,
            userId: AppState.currentUserId,
            type: evt.type,
            videoTime: evt.videoTime,
            team: evt.team || null,
            teamName: null,
            zone: evt.zone || null,
            notes: evt.notes || '',
            isRefDecision: isRef,
            half: evt.videoTime < (AppState.currentGame.duration || 2400) / 2 ? 1 : 2,
            competency: this.getCompetency(evt.type),
            source: 'ai',
            comments: [],
            createdAt: new Date().toISOString(),
        };

        if (event.team && AppState.currentGame) {
            event.teamName = event.team === 'home' ? AppState.currentGame.homeTeam : AppState.currentGame.awayTeam;
        }

        const saved = await db.addEvent(event);
        AppState.events.push(saved);
        AppState.events.sort((a, b) => a.videoTime - b.videoTime);
        renderEventLog();
        renderTimelineMarkers();
    },

    getCompetency(type) {
        const map = {
            'penalty': 'big_decisions', 'free_kick': 'big_decisions', 'advantage': 'big_decisions',
            'yellow_card': 'big_decisions', 'red_card': 'big_decisions', 'tmo_review': 'big_decisions',
            'scrum_penalty': 'scrum', 'offside': 'big_decisions',
            'high_tackle': 'big_decisions', 'not_rolling_away': 'breakdown',
            'obstruction': 'big_decisions', 'collapsing': 'scrum',
            'scrum': 'scrum', 'lineout': 'lineout', 'ruck': 'breakdown',
            'maul': 'breakdown', 'kickoff': 'restarts',
            'correct_decision': 'big_decisions', 'wrong_decision': 'big_decisions',
            'non_decision': 'big_decisions', 'referee_error': 'big_decisions',
        };
        return map[type] || null;
    },

    // Parse AI text response into event objects
    parseAIResponse(text) {
        const lines = text.trim().split('\n').filter(l => l.trim() && l.includes('|'));
        const events = [];

        for (const line of lines) {
            const parts = line.split('|').map(p => p.trim());
            if (parts.length < 2) continue;

            const timeStr = parts[0];
            const videoTime = this.parseTime(timeStr);
            if (videoTime === null) continue;

            const rawType = parts[1].toLowerCase().replace(/[\s-]+/g, '_');
            const eventType = this.matchType(rawType);
            if (!eventType) continue;

            const team = parts[2] ? this.matchTeam(parts[2]) : null;
            const zone = parts[3] ? this.matchZone(parts[3]) : null;
            const notes = parts[4] || '';

            // Deduplicate: skip if same event type within 10 seconds already exists
            const isDuplicate = AppState.events.some(
                e => e.type === eventType && Math.abs(e.videoTime - videoTime) < 10
            );
            if (isDuplicate) continue;

            events.push({
                videoTime,
                type: eventType,
                team,
                zone,
                notes: notes.trim(),
            });
        }

        return events;
    },

    parseTime(str) {
        const clean = str.trim();
        const ms = clean.match(/^(\d{1,3}):(\d{2})$/);
        if (ms) return parseInt(ms[1]) * 60 + parseInt(ms[2]);
        const hms = clean.match(/^(\d+):(\d{1,2}):(\d{2})$/);
        if (hms) return parseInt(hms[1]) * 3600 + parseInt(hms[2]) * 60 + parseInt(hms[3]);
        return null;
    },

    matchType(raw) {
        const map = {
            'scrum': 'scrum', 'lineout': 'lineout', 'line_out': 'lineout',
            'ruck': 'ruck', 'maul': 'maul', 'try': 'try',
            'conversion': 'conversion', 'penalty_kick': 'penalty_kick',
            'drop_goal': 'drop_goal', 'kickoff': 'kickoff', 'kick_off': 'kickoff',
            'knock_on': 'knock_on', 'turnover': 'turnover',
            'substitution': 'substitution', 'penalty': 'penalty',
            'free_kick': 'free_kick', 'advantage': 'advantage',
            'yellow_card': 'yellow_card', 'red_card': 'red_card',
            'tmo_review': 'tmo_review', 'scrum_penalty': 'scrum_penalty',
            'offside': 'offside', 'high_tackle': 'high_tackle',
            'not_rolling_away': 'not_rolling_away', 'obstruction': 'obstruction',
            'collapsing': 'collapsing',
        };
        return map[raw] || null;
    },

    matchTeam(raw) {
        const t = raw.toLowerCase().trim();
        if (t === 'home' || t === 'h') return 'home';
        if (t === 'away' || t === 'a') return 'away';
        if (AppState.currentGame) {
            if (AppState.currentGame.homeTeam.toLowerCase().includes(t)) return 'home';
            if (AppState.currentGame.awayTeam.toLowerCase().includes(t)) return 'away';
        }
        return null;
    },

    matchZone(raw) {
        const z = raw.toLowerCase().trim().replace(/\s+/g, '-');
        const map = {
            'own-22': 'own-22', 'own-half': 'own-half', 'opp-half': 'opp-half',
            'opp-22': 'opp-22', 'opp-try-line': 'opp-try-line',
        };
        return map[z] || null;
    },

    cleanup() {
        this.isAnalyzing = false;
        this.abortController = null;
        this.progress = { current: 0, total: 0 };
    },

    stop() {
        if (this.abortController) {
            this.abortController.abort();
        }
        this.cleanup();
        showWatchOverlay('stopped');
        showToast('Analysis stopped', 'info');
    }
};


// === UI Functions ===

function initAIVision() {
    AI_VISION.loadApiKey();

    // Watch & Code button — shows modal overlay
    document.getElementById('watchAndCodeBtn')?.addEventListener('click', () => {
        if (!AI_VISION.apiKey) {
            document.getElementById('aiKeyModal')?.classList.remove('hidden');
            return;
        }
        if (!AppState.currentGame) {
            showToast('Please load a game first', 'error');
            return;
        }
        const video = document.getElementById('videoPlayer');
        if (!video?.duration || video.duration === Infinity || video.duration === 0) {
            showToast('Please load a video first', 'error');
            return;
        }
        // Show the modal overlay for AI config
        showAIConfigModal();
    });

    // API Key modal
    document.getElementById('configureAIKeyBtn')?.addEventListener('click', () => {
        document.getElementById('aiKeyModal')?.classList.remove('hidden');
        const input = document.getElementById('geminiKeyInput');
        if (AI_VISION.apiKey) input.value = AI_VISION.apiKey;
    });

    document.getElementById('closeAIKeyModal')?.addEventListener('click', () => {
        document.getElementById('aiKeyModal')?.classList.add('hidden');
    });

    document.getElementById('saveAIKey')?.addEventListener('click', () => {
        const key = document.getElementById('geminiKeyInput')?.value.trim();
        if (!key) {
            showToast('Please enter an API key', 'error');
            return;
        }
        AI_VISION.saveApiKey(key);
        document.getElementById('aiKeyModal')?.classList.add('hidden');
        updateAIKeyStatus();
        showToast('Gemini API key saved', 'success');
    });

    document.getElementById('removeAIKey')?.addEventListener('click', () => {
        AI_VISION.removeApiKey();
        const input = document.getElementById('geminiKeyInput');
        if (input) input.value = '';
        updateAIKeyStatus();
        showToast('API key removed', 'info');
    });

    // Legacy config panel handlers (keep for backward compat)
    document.getElementById('startWatchBtn')?.addEventListener('click', () => {
        const interval = parseInt(document.getElementById('frameInterval')?.value) || 15;
        document.getElementById('watchConfigPanel')?.classList.add('hidden');
        AI_VISION.watchAndCode({ interval, batchSize: 6 });
    });

    document.getElementById('cancelWatchBtn')?.addEventListener('click', () => {
        document.getElementById('watchConfigPanel')?.classList.add('hidden');
    });

    document.getElementById('stopWatchBtn')?.addEventListener('click', () => {
        AI_VISION.stop();
    });

    updateAIKeyStatus();
}

function showAIConfigModal() {
    // Remove existing modal if present
    document.getElementById('aiWatchModal')?.remove();

    const video = document.getElementById('videoPlayer');
    const duration = video ? Math.round(video.duration) : 0;
    const estFrames15 = Math.ceil(duration / 15);
    const estFrames30 = Math.ceil(duration / 30);

    const modal = document.createElement('div');
    modal.id = 'aiWatchModal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal-content" style="max-width:440px">
            <div class="modal-header">
                <h3><i class="fas fa-robot"></i> AI Watch &amp; Code</h3>
                <button class="modal-close" id="closeAIWatchModal"><i class="fas fa-times"></i></button>
            </div>
            <div class="modal-body" style="padding:16px">
                <p style="color:var(--text-secondary);margin-bottom:14px;font-size:0.9rem">
                    The AI will capture frames from your video and analyze them using Gemini Vision to identify rugby events. Events will be added directly to your Decision Log.
                </p>
                <div style="margin-bottom:14px">
                    <label style="font-size:0.85rem;color:var(--text-secondary);display:block;margin-bottom:6px">Frame capture interval</label>
                    <select id="aiIntervalSelect" class="select-field" style="width:100%">
                        <option value="10">Every 10 seconds — detailed (~${Math.ceil(duration/10)} frames)</option>
                        <option value="15" selected>Every 15 seconds — balanced (~${estFrames15} frames)</option>
                        <option value="20">Every 20 seconds — faster (~${Math.ceil(duration/20)} frames)</option>
                        <option value="30">Every 30 seconds — quick scan (~${estFrames30} frames)</option>
                    </select>
                </div>
                <div style="display:flex;align-items:center;gap:8px;padding:10px;background:rgba(76,175,80,0.1);border-radius:8px;margin-bottom:14px">
                    <i class="fas fa-check-circle" style="color:var(--green)"></i>
                    <span style="font-size:0.85rem">Gemini API connected</span>
                    <button id="aiModalChangeKey" class="btn btn-ghost btn-small" style="margin-left:auto;font-size:0.75rem"><i class="fas fa-key"></i></button>
                </div>
                <div style="display:flex;gap:8px;justify-content:flex-end">
                    <button id="aiModalCancel" class="btn btn-ghost">Cancel</button>
                    <button id="aiModalStart" class="btn btn-accent"><i class="fas fa-play"></i> Start Analysis</button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    document.getElementById('closeAIWatchModal').addEventListener('click', () => modal.remove());
    document.getElementById('aiModalCancel').addEventListener('click', () => modal.remove());
    document.getElementById('aiModalChangeKey').addEventListener('click', () => {
        modal.remove();
        document.getElementById('aiKeyModal')?.classList.remove('hidden');
        const input = document.getElementById('geminiKeyInput');
        if (AI_VISION.apiKey) input.value = AI_VISION.apiKey;
    });
    document.getElementById('aiModalStart').addEventListener('click', () => {
        const interval = parseInt(document.getElementById('aiIntervalSelect').value) || 15;
        modal.remove();
        AI_VISION.watchAndCode({ interval, batchSize: 6 });
    });

    // Close on backdrop click
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.remove();
    });
}

function updateAIKeyStatus() {
    const statusEl = document.getElementById('aiKeyStatus');
    if (!statusEl) return;
    if (AI_VISION.apiKey) {
        statusEl.innerHTML = '<i class="fas fa-check-circle" style="color:var(--green)"></i> Gemini API connected';
        statusEl.className = 'ai-key-status connected';
    } else {
        statusEl.innerHTML = '<i class="fas fa-exclamation-circle" style="color:var(--yellow)"></i> No API key configured';
        statusEl.className = 'ai-key-status disconnected';
    }
}

// Floating progress overlay on top of video
function showWatchOverlay(state, progress = null, eventsFound = 0, errorMsg = '') {
    let overlay = document.getElementById('aiWatchOverlay');

    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'aiWatchOverlay';
        overlay.style.cssText = `
            position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
            background: rgba(20, 25, 35, 0.95); backdrop-filter: blur(12px);
            border: 1px solid rgba(255,255,255,0.1); border-radius: 14px;
            padding: 14px 22px; min-width: 380px; max-width: 500px;
            z-index: 9999; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
            font-family: inherit; color: #fff;
        `;
        document.body.appendChild(overlay);
    }

    const pct = progress?.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

    switch (state) {
        case 'starting':
            overlay.innerHTML = `
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
                    <i class="fas fa-robot" style="color:var(--accent);font-size:1.1rem"></i>
                    <span style="font-weight:600">AI Watch &amp; Code</span>
                    <button onclick="AI_VISION.stop();document.getElementById('aiWatchOverlay')?.remove()" class="btn btn-ghost btn-small" style="margin-left:auto;font-size:0.75rem"><i class="fas fa-times"></i> Stop</button>
                </div>
                <div style="font-size:0.85rem;color:var(--text-secondary)"><i class="fas fa-spinner fa-spin"></i> Preparing...</div>
            `;
            break;

        case 'capturing':
            overlay.innerHTML = `
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
                    <i class="fas fa-camera" style="color:var(--accent);font-size:1.1rem"></i>
                    <span style="font-weight:600">Capturing Frames</span>
                    <span style="margin-left:auto;font-size:0.8rem;color:var(--text-secondary)">${progress?.current || 0} / ${progress?.total || 0}</span>
                    <button onclick="AI_VISION.stop();document.getElementById('aiWatchOverlay')?.remove()" class="btn btn-ghost btn-small" style="font-size:0.75rem"><i class="fas fa-times"></i></button>
                </div>
                <div style="height:4px;background:rgba(255,255,255,0.1);border-radius:2px;overflow:hidden">
                    <div style="height:100%;width:${pct}%;background:var(--accent);border-radius:2px;transition:width 0.3s"></div>
                </div>
            `;
            break;

        case 'analyzing':
            overlay.innerHTML = `
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
                    <i class="fas fa-brain" style="color:var(--purple, #a78bfa);font-size:1.1rem"></i>
                    <span style="font-weight:600">AI Analyzing</span>
                    <span style="margin-left:auto;font-size:0.8rem;color:var(--text-secondary)">Batch ${progress?.current || 0}/${progress?.total || 0}</span>
                    <button onclick="AI_VISION.stop();document.getElementById('aiWatchOverlay')?.remove()" class="btn btn-ghost btn-small" style="font-size:0.75rem"><i class="fas fa-times"></i></button>
                </div>
                <div style="height:4px;background:rgba(255,255,255,0.1);border-radius:2px;overflow:hidden;margin-bottom:6px">
                    <div style="height:100%;width:${pct}%;background:var(--purple, #a78bfa);border-radius:2px;transition:width 0.3s"></div>
                </div>
                <div style="font-size:0.8rem;color:var(--green)">
                    ${eventsFound > 0 ? `<i class="fas fa-check"></i> ${eventsFound} event${eventsFound !== 1 ? 's' : ''} found and added to log` : '<i class="fas fa-spinner fa-spin"></i> Waiting for results...'}
                </div>
            `;
            break;

        case 'done':
            overlay.innerHTML = `
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
                    <i class="fas fa-check-circle" style="color:var(--green);font-size:1.1rem"></i>
                    <span style="font-weight:600">Analysis Complete</span>
                    <button onclick="document.getElementById('aiWatchOverlay')?.remove()" class="btn btn-ghost btn-small" style="margin-left:auto;font-size:0.75rem"><i class="fas fa-times"></i></button>
                </div>
                <div style="font-size:0.85rem;color:var(--green)">
                    ${eventsFound} event${eventsFound !== 1 ? 's' : ''} identified and added to your Decision Log
                </div>
            `;
            setTimeout(() => overlay?.remove(), 8000);
            break;

        case 'stopped':
            overlay.innerHTML = `
                <div style="display:flex;align-items:center;gap:10px">
                    <i class="fas fa-stop-circle" style="color:var(--yellow);font-size:1.1rem"></i>
                    <span style="font-weight:600">Analysis Stopped</span>
                </div>
            `;
            setTimeout(() => overlay?.remove(), 3000);
            break;

        case 'error':
            overlay.innerHTML = `
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
                    <i class="fas fa-exclamation-triangle" style="color:var(--red);font-size:1.1rem"></i>
                    <span style="font-weight:600">Analysis Failed</span>
                    <button onclick="document.getElementById('aiWatchOverlay')?.remove()" class="btn btn-ghost btn-small" style="margin-left:auto;font-size:0.75rem"><i class="fas fa-times"></i></button>
                </div>
                <div style="font-size:0.8rem;color:var(--red)">${errorMsg}</div>
            `;
            setTimeout(() => overlay?.remove(), 8000);
            break;
    }
}

// Legacy function compatibility
function showWatchUI(state, count, errorMsg) {
    showWatchOverlay(state, null, count, errorMsg);
}

function updateWatchProgress(progress, phase) {
    updateWatchOverlay(phase || 'capturing', progress);
}

// Init on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    initAIVision();
});
