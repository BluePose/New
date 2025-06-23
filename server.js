require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const fs = require('fs');

// ===================================================================================
// 설정 (Configuration)
// ===================================================================================
const config = {
    PORT: process.env.PORT || 3000,
    AI_PASSWORD: '5001',
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
    API_REQUEST_TIMEOUT: 30000,
    MEETING_MINUTES_MAX_TOKENS: 4096,
    AI_RESPONSE_BASE_DELAY: 5000,
    AI_RESPONSE_RANDOM_DELAY: 3000,
    LOG_FILE_PATH: path.join(__dirname, 'chat.log'),
    MAX_LOG_BUFFER_SIZE: 200,
};

const logStream = fs.createWriteStream(config.LOG_FILE_PATH, { flags: 'a' });

// ===================================================================================
// 전역 상태 관리
// ===================================================================================
const users = new Map();
const usersByName = new Map();
const aiStyles = new Map();
const aiMemories = new Map();
const rawConversationLog = [];
const apiCallQueue = [];
const turnQueue = [];
const pendingAIResponses = new Map();
const aiPending = new Map();
const answeredMentionIds = new Set();
const questionAnsweredByAI = new Map();

let isProcessingTurn = false;
let isMeetingMinutesMode = false;
let isProcessingQueue = false;

const API_CALL_INTERVAL = 4000;
const AI_MEMORY_INTERVAL = 10;

const SOCKET_EVENTS = {
    CONNECTION: 'connection', DISCONNECT: 'disconnect', JOIN: 'join',
    JOIN_SUCCESS: 'join_success', JOIN_ERROR: 'join_error', CHAT_MESSAGE: 'chat_message',
    MESSAGE: 'message', USER_LIST: 'userList',
};

const INTENT_TYPES = ['질문', '동의', '반박', '농담', '새로운 주제 제안', '정보 제공', '감정 표현', '요약'];

const personaPool = [
    '쾌활하고 수다스러운 20대 대학생, 농담을 자주 함',
    '차분하고 논리적인 30대 직장인, 정보 전달을 좋아함',
    '감성적이고 공감 잘하는 40대, 리액션이 풍부함',
    '냉정하고 직설적인 성격, 짧고 단호한 답변을 선호함',
    '호기심 많고 질문을 자주 하는 어린이',
    '유머러스하고 장난기 많은 친구',
    '진지하고 분석적인 전문가',
    '느긋하고 여유로운 여행가',
];
const interactionStylePool = [ '논쟁형', '공감형', '정보형', '질문형', '유머형', '리액션형' ];

// ===================================================================================
// Google Gemini API 설정
// ===================================================================================
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

if (!config.GOOGLE_API_KEY) {
    console.error('Google API 키가 설정되지 않았습니다. .env 파일을 확인해주세요.');
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(config.GOOGLE_API_KEY);
const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];
const model = genAI.getGenerativeModel({ 
    model: "gemini-2.0-flash", safetySettings,
    generationConfig: { temperature: 0.9, topK: 40, topP: 0.95, maxOutputTokens: 2048, },
}, { apiVersion: 'v1', timeout: config.API_REQUEST_TIMEOUT });

// ===================================================================================
// 핵심 로직 함수들
// ===================================================================================

function logMessage(msgObj) {
    logStream.write(JSON.stringify(msgObj) + '\n');
    rawConversationLog.push(msgObj);
    if (rawConversationLog.length > config.MAX_LOG_BUFFER_SIZE) rawConversationLog.shift();
}

async function processApiQueue() {
    if (isProcessingQueue || apiCallQueue.length === 0) return;
    isProcessingQueue = true;
    const { apiCall, resolve, reject } = apiCallQueue.shift();
    try {
        resolve(await apiCall());
    } catch (error) {
        reject(error);
    } finally {
        setTimeout(() => { isProcessingQueue = false; processApiQueue(); }, API_CALL_INTERVAL);
    }
}

function addToApiQueue(apiCallFunction) {
    return new Promise((resolve, reject) => {
        apiCallQueue.push({ apiCall: apiCallFunction, resolve, reject });
        if (!isProcessingQueue) processApiQueue();
    });
}

function getParticipantNames() {
    return Array.from(users.values()).map(u => u.username);
}

function tagMessage(msg, aiName, targetName) {
    if (!usersByName.has(msg.from)) return `[퇴장한 사람→${msg.to || '모두'}] ${msg.content}`;
    if (msg.from === aiName) return `[나→${msg.to || '모두'}] ${msg.content}`;
    if (msg.from === targetName) return `[상대방→${msg.to || '모두'}] ${msg.content}`;
    return `[참여자:${msg.from}→${msg.to || '모두'}] ${msg.content}`;
}

function analyzeConversationStyle(history, aiName, targetName, allIntents) {
    const participantNames = getParticipantNames();
    const { persona = '', interactionStyle = '' } = aiStyles.get(aiName) || {};
    const memories = aiMemories.get(aiName) || [];

    let intentPrompt = '';
    if (allIntents && allIntents.size > 0) {
        const myIntent = allIntents.get(aiName) || '정해지지 않음';
        const otherIntents = Array.from(allIntents.entries())
            .filter(([name]) => name !== aiName)
            .map(([name, intent]) => `- ${name}: '${intent}'`);
        intentPrompt = `
# 동료 AI와의 의도 조율
- 너의 의도: 너는 이번 턴에 '${myIntent}' 방향으로 대화에 기여할 것이다.
- 다른 AI 동료들의 의도:
${otherIntents.length > 0 ? otherIntents.join('\n') : '- 다른 AI는 아직 의도를 정하지 않음.'}
- 위 정보를 바탕으로 동료와 협력하되, 너의 역할을 침범하지 않도록 주의하며 답변하라.
---`;
    }

    const memoryPrompt = memories.length > 0
        ? `
# 개인적인 기억 (최근 활동 요약)
- ${memories.join('\n- ')}
- 이 기억을 바탕으로 이전의 발언과 일관성 있는 대화를 이어가라.
---`
        : '';

    const taggedHistory = history.length > 0
        ? `
# 최근 대화 내용
${history.slice(-5).map(msg => tagMessage(msg, aiName, targetName)).join('\n')}
---`
        : '';

    return `
# 역할 및 목표
- 너의 이름은 '${aiName}'이며, 채팅에 참여한 사람 중 한 명이다.
- 너의 목표는 주어진 페르소나와 상호작용 스타일에 맞춰, 다른 참여자들과 자연스럽고 의미 있는 대화를 나누는 것이다.
- 너는 '${targetName || '모두'}'를 대상으로 말해야 한다.

# 페르소나 및 스타일
- 너의 페르소나: ${persona || '지정되지 않음'}
- 너의 상호작용 성향: ${interactionStyle || '지정되지 않음'}
- 이 정체성을 대화 내내 일관되게 유지하라.

# 주요 행동 지침
1.  **독창성 추구**: 다른 참여자의 의견을 단순히 반복하기보다, 그 의견을 바탕으로 자신만의 새로운 관점, 질문, 또는 정보를 더하여 대화를 발전시켜라. 모든 발언이 완전히 새로울 필요는 없지만, 너만의 가치를 더해야 한다.
2.  **자연스러운 대화**: 실제 사람이 대화하는 것처럼 행동하라. 문맥에 맞는 길이와 톤을 사용하고, 완전한 문장으로 말하는 것을 기본으로 하라.
3.  **인간적인 모습 유지**: AI라는 사실을 절대 드러내지 말고, '${aiName}'라는 이름으로만 활동하라. 실수했다면 사람처럼 자연스럽게 인정하고 수정하라.

# 제약 조건
- 이모티콘은 사용하지 않는다.
- "제 생각엔...", "저는 ~라고 생각합니다"와 같은 메타 발언은 최소화하고, 자연스럽게 의견을 제시하라.
- 너의 이름('${aiName}')을 직접 언급하는 것은 피하라. (예: "저는 철수인데요..." 와 같이 말하지 않음)

${intentPrompt}
${memoryPrompt}
${taggedHistory}

# 최종 지시
- 위의 모든 규칙과 맥락을 종합적으로 고려하여, 답변을 생성하기 전에 단계별로 어떻게 말할 것인지 머릿속으로 계획을 세워라.
- 그 계획에 따라, '${aiName}'로서 할 가장 적절한 한두 문장의 메시지를 생성하라.
`.trim();
}

async function generateAIResponse(message, context, aiName, targetName = '', allIntents = null) {
    try {
        const user = usersByName.get(aiName);
        if (!user) throw new Error(`${aiName} 사용자를 찾을 수 없습니다.`);
        
        const stylePrompt = analyzeConversationStyle(context, aiName, targetName, allIntents);
        const historyForGemini = context.slice(-50);
        
        const collapsedHistory = [];
        if (historyForGemini.length > 0) {
            let lastRole = null;
            for (const msg of historyForGemini) {
                const currentRole = msg.from === aiName ? 'model' : 'user';
                const text = `${msg.from}: ${msg.content}`;
                if (collapsedHistory.length > 0 && lastRole === currentRole) {
                    collapsedHistory[collapsedHistory.length - 1].parts[0].text += `\n${text}`;
                } else {
                    collapsedHistory.push({ role: currentRole, parts: [{ text }] });
                    lastRole = currentRole;
                }
            }
        }
        
        const contents = [{ role: 'user', parts: [{ text: stylePrompt }] }, ...collapsedHistory];
        if (contents.length > 1 && contents[0].role === contents[1].role) {
            contents[0].parts[0].text += '\n' + contents[1].parts[0].text;
            contents.splice(1, 1);
        }

        const result = await addToApiQueue(() => model.generateContent({ contents, generationConfig: { temperature: user.temperature, topK: user.topK, topP: user.topP, maxOutputTokens: 2048 } }));
        let aiResponse = (await result.response).text();
        
        const participantNames = getParticipantNames();
        for (const name of participantNames) {
            if (name !== aiName) {
                const patterns = [new RegExp(`^${name}[:\\s]*`, 'gi'), new RegExp(`^@?${name}[:\\s]*`, 'gi'), new RegExp(`\\n${name}[:\\s]*`, 'gi')];
                patterns.forEach(pattern => { aiResponse = aiResponse.replace(pattern, ''); });
            }
        }
        aiResponse = aiResponse.replace(/\[[^\]]*\][ \t]*/g, '');
        let cleanResponse = aiResponse.replace(/[^\uAC00-\uD7A3\u3131-\u318E\u1100-\u11FFa-zA-Z0-9.,!?\s]/g, '').trim();
        if (aiName && cleanResponse.includes(aiName)) {
            cleanResponse = cleanResponse.replaceAll(aiName, '').replaceAll('@' + aiName, '').trim();
        }
        if (!cleanResponse) {
            console.log(`AI ${aiName}이(가) 유효한 답변 생성에 실패했습니다.`);
            return '...'; // 빈 답변 대신 최소한의 응답
        }
        return cleanResponse;
    } catch (error) {
        console.error(`AI ${aiName} 응답 생성 중 오류:`, error.message);
        return '죄송합니다, 답변을 생성하는 데 문제가 발생했습니다.';
    }
}

async function generateAIIntent(message, context, aiName) {
    try {
        const { persona } = aiStyles.get(aiName) || {};
        const historySummary = context.slice(-5).map(m => `${m.from}: ${m.content}`).join('\n');
        const intentPrompt = `당신은 '${persona}' 페르소나를 가진 AI입니다.\n채팅에서 사용자가 말했습니다: "${message}"\n최근 대화:\n${historySummary}\n\n당신의 페르소나와 대화 맥락에 기반하여, 다음 중 당신의 답변 의도를 하나만 고르세요: ${INTENT_TYPES.join(', ')}\n\n선택:`;
        
        const result = await addToApiQueue(() => model.generateContent({ contents: [{ role: 'user', parts: [{ text: intentPrompt }] }], generationConfig: { temperature: 0.5, maxOutputTokens: 20 } }));
        const intent = (await result.response).text().trim();
        const foundIntent = INTENT_TYPES.find(type => intent.includes(type));
        
        if (foundIntent) {
            console.log(`[의도 생성] AI '${aiName}' -> '${foundIntent}'`);
            return { aiName, intent: foundIntent };
        }
        console.warn(`[의도 생성] AI '${aiName}'가 잘못된 의도 생성: '${intent}'. '감정 표현'으로 대체.`);
        return { aiName, intent: '감정 표현' };
    } catch (error) {
        console.error(`${aiName} 의도 생성 오류:`, error);
        return null;
    }
}

function findMentionedAI(message) {
    const aiUsernames = Array.from(users.values()).filter(u => u.isAI).map(u => u.username);
    for (const name of aiUsernames) {
        if (new RegExp(`\\b${name}\\b`, 'i').test(message)) return name;
    }
    return null;
}

function selectRespondingAIs(candidateAIs, msgObj, mentionedAI) {
    const respondingAIs = [];
    const lastSpeaker = usersByName.get(msgObj.from);
    const isLastSpeakerHuman = !lastSpeaker || !lastSpeaker.isAI;
    const PARTICIPATION_THRESHOLD = 55;

    for (const [id, aiUser] of candidateAIs) {
        let score = 0;
        const reasons = [];

        if (aiUser.username === mentionedAI) {
            score = 100;
            reasons.push("직접 멘션");
        } else {
            const spontaneityScore = Math.floor(Math.random() * 30);
            score += spontaneityScore;
            reasons.push(`자발성(${spontaneityScore})`);
            
            if (msgObj.content.includes('?')) {
                score += 50;
                reasons.push("질문");
            }
            if (isLastSpeakerHuman) {
                score += 35;
                reasons.push("사람 발언");
            } else {
                score += 30;
                reasons.push("AI 발언");
            }
            if (['하지만', '그런데', '정말', '진짜', '왜', '어떻게', '내 생각엔', '제 생각엔', '동의', '반박'].some(k => msgObj.content.includes(k))) {
                score += 25;
                reasons.push("흥미로운 키워드");
            }
        }
        
        console.log(`[참여 점수] ${aiUser.username}: ${score}점 (사유: ${reasons.join(', ')})`);
        if (score >= PARTICIPATION_THRESHOLD) {
            console.log(`[참여 결정] ${aiUser.username}`);
            respondingAIs.push({ aiUser, score, idx: respondingAIs.length });
        }
    }
    return respondingAIs.sort((a, b) => b.score - a.score);
}

function findUnansweredMention(aiName, history) {
    const recentHistory = history.slice(-20);
    for (const msg of recentHistory.reverse()) { // 최근 메시지부터 확인
        const isMentioned = (msg.content.includes(aiName) || msg.content.includes(`@${aiName}`));
        if (isMentioned && !answeredMentionIds.has(msg.messageId)) {
            const answeredAIs = questionAnsweredByAI.get(msg.messageId);
            if (!answeredAIs || !answeredAIs.has(aiName)) return msg;
        }
    }
    return null;
}

function markMentionAsAnswered(messageId, aiName) {
    answeredMentionIds.add(messageId);
    if (!questionAnsweredByAI.has(messageId)) questionAnsweredByAI.set(messageId, new Set());
    questionAnsweredByAI.get(messageId).add(aiName);
    console.log(`[멘션 처리] ${aiName}이(가) ${messageId}에 답변했습니다.`);
}

async function scheduleAIResponses(respondingAIs, msgObj, allIntents, historySnapshot) {
    const responsePromises = respondingAIs
        .filter(({ aiUser }) => allIntents.has(aiUser.username))
        .map(({ aiUser, idx }) => new Promise(resolve => {
            if (aiPending.get(aiUser.username)) {
                console.log(`[응답 건너뛰기] ${aiUser.username}은(는) 이미 다른 응답을 준비 중입니다.`);
                return resolve(null);
            }
            aiPending.set(aiUser.username, true);

            const delay = config.AI_RESPONSE_BASE_DELAY + Math.floor(Math.random() * config.AI_RESPONSE_RANDOM_DELAY) + (idx * 1500);
            console.log(`[응답 예약] ${aiUser.username} (지연: ${delay}ms)`);
            
            const timeoutId = setTimeout(async () => {
                pendingAIResponses.delete(aiUser.username);
                try {
                    if (!usersByName.has(aiUser.username)) {
                        console.log(`[응답 취소] ${aiUser.username}이(가) 퇴장했습니다.`);
                        return resolve(null);
                    }
                    
                    let targetMessage = msgObj.content;
                    let targetSender = msgObj.from;
                    let toField = msgObj.from; // 기본적으로 메시지를 보낸 사람에게

                    const unansweredMention = findUnansweredMention(aiUser.username, historySnapshot);
                    if (unansweredMention) {
                        console.log(`[멘션 발견] ${aiUser.username}이(가) ${unansweredMention.from}의 이전 멘션에 응답합니다.`);
                        targetMessage = unansweredMention.content;
                        targetSender = unansweredMention.from;
                        toField = unansweredMention.from;
                        markMentionAsAnswered(unansweredMention.messageId, aiUser.username);
                    }

                    const aiResponse = await generateAIResponse(targetMessage, historySnapshot, aiUser.username, targetSender, allIntents);
                    
                    if (aiResponse) {
                        resolve({ from: aiUser.username, to: toField, content: aiResponse, timestamp: new Date(), messageId: `ai_${Date.now()}_${aiUser.username}` });
                    } else {
                        resolve(null);
                    }
                } catch (error) {
                    console.error(`${aiUser.username} 응답 생성 오류:`, error);
                    resolve(null);
                } finally {
                    aiPending.set(aiUser.username, false);
                }
            }, delay);
            pendingAIResponses.set(aiUser.username, timeoutId);
        }));
        
    return (await Promise.all(responsePromises)).filter(Boolean);
}

async function summarizeAndRememberForAllAIs() {
    console.log(`[메모리] ${rawConversationLog.length}번째 메시지 도달, 전체 AI 기억 생성을 시작합니다.`);
    const aiUsers = Array.from(users.values()).filter(user => user.isAI);
    const conversationChunk = rawConversationLog.slice(-AI_MEMORY_INTERVAL);
    
    for (const aiUser of aiUsers) {
        try {
            const summaryPrompt = `다음은 '${aiUser.username}'가 참여한 대화입니다. 이 대화에서 '${aiUser.username}'의 핵심 행동, 발언, 주장을 1~2문장으로 요약해주세요. '${aiUser.username}' 자신의 입장에서 작성하세요. (예: "나는 영화에 대해 이야기했다.")\n\n--- 대화 ---\n${conversationChunk.map(m => `${m.from}: ${m.content}`).join('\n')}\n\n--- 요약 ---`;
            const result = await addToApiQueue(() => model.generateContent(summaryPrompt));
            const summary = (await result.response).text().trim();
            if (summary) {
                if (!aiMemories.has(aiUser.username)) aiMemories.set(aiUser.username, []);
                const userMemories = aiMemories.get(aiUser.username);
                userMemories.push(summary);
                if (userMemories.length > 10) userMemories.shift();
                console.log(`[메모리] AI '${aiUser.username}'의 새 기억: "${summary}"`);
            }
        } catch (error) {
            console.error(`[메모리] AI '${aiUser.username}'의 기억 생성 오류:`, error);
        }
    }
}

async function handleMeetingMinutes(initiatingMsgObj) {
    const firstAI = Array.from(users.values()).find(u => u.isAI);
    if (!firstAI) {
        io.to('chat').emit(SOCKET_EVENTS.MESSAGE, { from: 'System', content: '회의록을 작성할 AI가 채팅방에 없습니다.', timestamp: new Date() });
        isMeetingMinutesMode = false;
        return;
    }
    
    console.log(`[회의록] 작성 AI: ${firstAI.username}`);
    const historyToSummarize = rawConversationLog.slice(0, -1);
    const participants = Array.from(usersByName.keys()).join(', ');
    const prompt = `당신은 전문 회의 서기입니다. 아래 대화 내용을 바탕으로 간결하고 명확한 회의록을 작성해주세요.\n\n회의록 형식:\n- **회의 일시:** ${new Date(initiatingMsgObj.timestamp).toLocaleString('ko-KR')}\n- **참석자:** ${participants}\n- **핵심 논의 주제:** (대화의 핵심 주제 1~2개 요약)\n- **주요 발언 및 결정 사항:** (참가자별 주요 의견과 결정 사항을 글머리 기호로 정리)\n- **향후 진행할 내용(Action Items):** (필요시 작성)\n\n--- 대화 내용 시작 ---\n${historyToSummarize.map(msg => `${msg.from}: ${msg.content}`).join('\n')}\n--- 대화 내용 끝 ---`;

    try {
        const result = await addToApiQueue(() => model.generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: config.MEETING_MINUTES_MAX_TOKENS } }));
        const meetingMinutes = (await result.response).text();
        const minutesMessage = { from: firstAI.username, content: `**회의록이 작성되었습니다.**\n\n---\n\n${meetingMinutes}`, timestamp: new Date(), messageId: `minutes_${Date.now()}` };
        io.to('chat').emit(SOCKET_EVENTS.MESSAGE, minutesMessage);
        logMessage(minutesMessage);
        console.log(`[회의록] ${firstAI.username}이(가) 작성을 완료했습니다.`);
    } catch (error) {
        console.error('[회의록] 생성 오류:', error);
        io.to('chat').emit(SOCKET_EVENTS.MESSAGE, { from: 'System', content: '회의록 생성 중 오류가 발생했습니다.', timestamp: new Date() });
        isMeetingMinutesMode = false;
    }
}

async function processConversationTurn(msgObj) {
    const lastSpeaker = usersByName.get(msgObj.from);
    const isLastSpeakerHuman = !lastSpeaker || !lastSpeaker.isAI;

    if (isMeetingMinutesMode && isLastSpeakerHuman && msgObj.content.trim() !== '/회의록') {
        console.log('[모드 변경] 회의록 모드 해제. AI 대화 재개.');
        isMeetingMinutesMode = false;
    }
    if (msgObj.content.trim() === '/회의록' && isLastSpeakerHuman) {
        console.log('[명령어 감지] /회의록');
        isMeetingMinutesMode = true;
        await handleMeetingMinutes(msgObj);
        return;
    }
    if (isMeetingMinutesMode) return;
    
    const historySnapshot = [...rawConversationLog];
    const mentionedAI = findMentionedAI(msgObj.content);
    const candidateAIs = Array.from(users.entries()).filter(([, user]) => user.isAI && user.username !== msgObj.from).sort(() => Math.random() - 0.5);
    const respondingAIs = selectRespondingAIs(candidateAIs, msgObj, mentionedAI);
    
    if (respondingAIs.length === 0) return;
    
    const intentPromises = respondingAIs.map(({ aiUser }) => generateAIIntent(msgObj.content, historySnapshot, aiUser.username));
    const allIntents = new Map();
    (await Promise.all(intentPromises)).filter(Boolean).forEach(({ aiName, intent }) => allIntents.set(aiName, intent));
    console.log('[작업 공간] 모든 의도 수집 완료:', allIntents);
    
    const generatedMessages = await scheduleAIResponses(respondingAIs, msgObj, allIntents, historySnapshot);
    
    if (generatedMessages.length > 0) {
        console.log(`[턴 종료] ${generatedMessages.length}개의 AI 응답을 순차적으로 반영합니다.`);
        for (const aiMessage of generatedMessages) {
            io.to('chat').emit(SOCKET_EVENTS.MESSAGE, aiMessage);
            logMessage(aiMessage);
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        const nextTurnTrigger = generatedMessages.find(m => m.content.includes('?')) || generatedMessages[generatedMessages.length - 1];
        if (nextTurnTrigger) {
            console.log(`[다음 턴 예약] ${nextTurnTrigger.from}의 발언을 다음 턴 주제로 설정합니다.`);
            addToTurnQueue(nextTurnTrigger, false);
        }
    }
    
    if (rawConversationLog.length > 0 && rawConversationLog.length % AI_MEMORY_INTERVAL === 0) {
        summarizeAndRememberForAllAIs();
    }
}

function addToTurnQueue(msgObj, isPriority = false) {
    if (isPriority) turnQueue.unshift(msgObj); else turnQueue.push(msgObj);
    if (!isProcessingTurn) processTurnQueue();
}

function interruptAndClearQueue() {
    console.log('[인터럽트] 모든 AI 응답 예약 및 대기열을 초기화합니다.');
    for (const timeoutId of pendingAIResponses.values()) clearTimeout(timeoutId);
    pendingAIResponses.clear();
    aiPending.clear();
    turnQueue.length = 0;
}

async function processTurnQueue() {
    if (isProcessingTurn || turnQueue.length === 0) return;
    isProcessingTurn = true;
    const msgObj = turnQueue.shift();
    try {
        await processConversationTurn(msgObj);
    } catch (error) {
        console.error('[대화 관리자] 턴 처리 중 심각한 오류:', error);
    } finally {
        isProcessingTurn = false;
        processTurnQueue();
    }
}

// ===================================================================================
// 소켓 및 서버 설정
// ===================================================================================

app.use(express.static('public'));

io.on(SOCKET_EVENTS.CONNECTION, (socket) => {
    console.log('새로운 사용자가 연결되었습니다.');

    socket.on(SOCKET_EVENTS.JOIN, async (data) => {
        try {
            let { username, isAI, password, persona } = data;
            if (password === config.AI_PASSWORD) isAI = true;
            if (isAI && password !== config.AI_PASSWORD) {
                return socket.emit(SOCKET_EVENTS.JOIN_ERROR, '잘못된 AI 비밀번호입니다.');
            }
            if (usersByName.has(username)) {
                return socket.emit(SOCKET_EVENTS.JOIN_ERROR, '이미 사용 중인 사용자 이름입니다.');
            }

            socket.username = username;
            const userData = {
                username, isAI, persona,
                temperature: 0.75 + (Math.random() * 0.25),
                topP: 0.8 + (Math.random() * 0.15),
                topK: 20 + Math.floor(Math.random() * 21),
            };
            users.set(socket.id, userData);
            usersByName.set(username, { id: socket.id, ...userData });
            
            if (isAI) {
                if (!persona) {
                    persona = personaPool[Math.floor(Math.random() * personaPool.length)];
                }
                const interactionStyle = interactionStylePool[Math.floor(Math.random() * interactionStylePool.length)];
                aiStyles.set(username, { persona, interactionStyle });
            }

            socket.join('chat');
            socket.emit(SOCKET_EVENTS.JOIN_SUCCESS, { username, isAI });
            
            const joinMessage = { 
                from: 'System',
                to: null,
                content: `${username}님이 참여했습니다.`, 
                timestamp: new Date(),
                messageId: `system_${Date.now()}`
            };
            io.to('chat').emit(SOCKET_EVENTS.MESSAGE, joinMessage);
            logMessage(joinMessage);
            io.to('chat').emit(SOCKET_EVENTS.USER_LIST, Array.from(users.values()));

        } catch (error) {
            console.error('참여 처리 중 오류:', error);
            socket.emit(SOCKET_EVENTS.JOIN_ERROR, '서버 참여 중 오류가 발생했습니다.');
        }
    });

    socket.on(SOCKET_EVENTS.CHAT_MESSAGE, async (message) => {
        if (!users.has(socket.id)) return;
        
        interruptAndClearQueue();
        
        const msgObj = { 
            from: users.get(socket.id).username, 
            content: message, 
            timestamp: new Date(), 
            messageId: `${Date.now()}_${users.get(socket.id).username}` 
        };
        
        io.to('chat').emit(SOCKET_EVENTS.MESSAGE, msgObj);
        logMessage(msgObj);
        addToTurnQueue(msgObj, true);
    });

    socket.on(SOCKET_EVENTS.DISCONNECT, () => {
        const user = users.get(socket.id);
        if (user) {
            users.delete(socket.id);
            usersByName.delete(user.username);
            aiStyles.delete(user.username);
            aiMemories.delete(user.username);

            const leaveMessage = { 
                from: 'System',
                to: null,
                content: `${user.username}님이 퇴장했습니다.`,
                timestamp: new Date(),
                messageId: `system_${Date.now()}`
            };
            io.to('chat').emit(SOCKET_EVENTS.MESSAGE, leaveMessage);
            logMessage(leaveMessage);
            io.to('chat').emit(SOCKET_EVENTS.USER_LIST, Array.from(users.values()));
        }
    });
});

async function startServer() {
    try {
        console.log('Google AI API 연결 테스트 시작...');
        const chat = model.startChat();
        const result = await chat.sendMessage("안녕하세요");
        const response = await result.response;
        console.log('Google AI API 테스트 성공:', response.text());

        http.listen(config.PORT, () => {
            console.log(`서버가 포트 ${config.PORT}에서 실행 중입니다.`);
        });
    } catch (error) {
        console.error('Google AI API 연결 테스트 실패. 서버를 시작할 수 없습니다.', error.message);
        process.exit(1);
    }
}

startServer(); 