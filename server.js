require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

// ===================================================================================
// 설정 (Configuration)
// ===================================================================================
const config = {
    PORT: process.env.PORT || 3000,
    AI_PASSWORD: '5001',
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
    API_REQUEST_TIMEOUT: 30000,
    MEETING_MINUTES_MAX_TOKENS: 4096,
    AI_RESPONSE_BASE_DELAY: 4000,
    AI_RESPONSE_RANDOM_DELAY: 3000,
    LOG_FILE_PATH: path.join(__dirname, 'chat.log'),
    MAX_LOG_BUFFER_SIZE: 200,
    CONTEXT_SUMMARY_INTERVAL: 120000, // 2분마다 대화 주제 요약
    MAX_CONTEXT_LENGTH: 25, // AI의 단기 기억(컨텍스트) 최대 길이
    TARGET_CONTEXT_LENGTH: 15, // 압축 후 목표 컨텍스트 길이
};

if (!config.GOOGLE_API_KEY) {
    console.error('Google API 키가 설정되지 않았습니다. .env 파일을 확인해주세요.');
    process.exit(1);
}

const logStream = fs.createWriteStream(config.LOG_FILE_PATH, { flags: 'a' });

// ===================================================================================
// 대화 맥락 관리 (Conversation Context)
// ===================================================================================
class ConversationContext {
    constructor() {
        this.fullHistory = []; // 회의록용 전체 대화 기록 (요약되지 않음)
        this.contextualHistory = []; // AI 답변용 단기 대화 기록 (요약됨)
        this.topicSummary = "대화가 시작되었습니다.";
        this.isSummarizing = false; // 중복 요약 방지 플래그
    }

    addMessage(msgObj) {
        const mentionRegex = /@(\w+)/g;
        const mentions = [...msgObj.content.matchAll(mentionRegex)].map(m => m[1]);
        
        let replyToId = null;
        if (mentions.length > 0) {
            const mentionedUser = mentions[0];
            const recentMessages = [...this.fullHistory].reverse();
            const repliedMessage = recentMessages.find(m => m.from === mentionedUser);
            if (repliedMessage) {
                replyToId = repliedMessage.id;
            }
        }

        const messageWithContext = { ...msgObj, replyToId };

        // 두 기록에 모두 메시지 추가
        this.fullHistory.push(messageWithContext);
        this.contextualHistory.push(messageWithContext);
        
        logStream.write(JSON.stringify(messageWithContext) + '\n');
        
        // 컨텍스트 길이 확인 및 비동기적 요약 실행
        if (this.contextualHistory.length > config.MAX_CONTEXT_LENGTH && !this.isSummarizing) {
            this.summarizeAndCompressContextualHistory(); // await 하지 않음 (백그라운드 실행)
        }
    }

    getContextualHistorySnapshot() {
        return [...this.contextualHistory];
    }
    
    getFullHistorySnapshot() {
        return [...this.fullHistory];
    }

    async summarizeAndCompressContextualHistory() {
        this.isSummarizing = true;
        console.log(`[메모리 압축] 컨텍스트 기록(${this.contextualHistory.length})이 임계값을 초과하여, 압축을 시작합니다.`);

        try {
            const numToSummarize = config.MAX_CONTEXT_LENGTH - config.TARGET_CONTEXT_LENGTH + 1;
            if (this.contextualHistory.length < numToSummarize) {
                return;
            }
            
            const toSummarize = this.contextualHistory.slice(0, numToSummarize);
            const remainingHistory = this.contextualHistory.slice(numToSummarize);

            const conversationToSummarize = toSummarize.map(m => `${m.from}: ${m.content}`).join('\n');
            const prompt = `다음은 긴 대화의 일부입니다. 이 대화의 핵심 내용을 단 한 문장으로 요약해주세요: \n\n${conversationToSummarize}`;

            // 요약을 위해 기존 모델 사용 (추가 비용 없음)
            const result = await model.generateContent(prompt);
            const summaryText = (await result.response).text().trim();

            const summaryMessage = {
                id: `summary_${Date.now()}`,
                from: 'System',
                content: `(요약) ${summaryText}`,
                timestamp: toSummarize[toSummarize.length - 1].timestamp, // 마지막 메시지 시점
                type: 'summary'
            };

            this.contextualHistory = [summaryMessage, ...remainingHistory];
            console.log(`[메모리 압축] 압축 완료. 현재 컨텍스트 기록 길이: ${this.contextualHistory.length}`);
        } catch (error) {
            console.error('[메모리 압축] 기록 요약 중 오류 발생:', error);
            // 요약 실패 시, 가장 오래된 기록을 단순히 잘라내서 무한 루프 방지
            this.contextualHistory.splice(0, config.MAX_CONTEXT_LENGTH - config.TARGET_CONTEXT_LENGTH + 1);
        } finally {
            this.isSummarizing = false;
        }
    }

    setTopicSummary(summary) {
        this.topicSummary = summary;
        console.log(`[맥락 업데이트] 새로운 대화 주제: ${summary}`);
    }
}
const conversationContext = new ConversationContext();

// ===================================================================================
// 전역 상태 관리
// ===================================================================================
const users = new Map();
const usersByName = new Map();
const aiStyles = new Map();
const aiMemories = new Map();
const participantRoles = new Map(); // <username, role>

const turnQueue = [];
let isProcessingTurn = false;
let isConversationPausedForMeetingNotes = false; // 회의록 작성 중 AI 대화 일시 중지 플래그

const SOCKET_EVENTS = {
    CONNECTION: 'connection', DISCONNECT: 'disconnect', JOIN: 'join',
    JOIN_SUCCESS: 'join_success', JOIN_ERROR: 'join_error', CHAT_MESSAGE: 'chat_message',
    MESSAGE: 'message', USER_LIST: 'userList',
};

const INTENT_TYPES = ['질문', '동의', '반박', '농담', '새로운 주제 제안', '정보 제공', '감정 표현'];

const personaPool = [ '쾌활하고 수다스러운 20대 대학생', '차분하고 논리적인 30대 직장인', '감성적이고 공감 잘하는 40대', '냉정하고 직설적인 성격' ];
const interactionStylePool = [ '논쟁형', '공감형', '정보형', '질문형', '유머형', '리액션형' ];

// ===================================================================================
// Google Gemini API 설정
// ===================================================================================
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const genAI = new GoogleGenerativeAI(config.GOOGLE_API_KEY);
const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

const MODEL_NAME = "gemini-1.5-flash-latest";

const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    safetySettings
}, { apiVersion: 'v1beta' });

const searchTool = [{ "google_search_retrieval": {} }];

// ===================================================================================
// 핵심 로직 함수들
// ===================================================================================
function logMessage(msgObj) {
    conversationContext.addMessage(msgObj);
}

function assignScribeRole() {
    const currentScribe = findUserByRole('Scribe');
    if (currentScribe) return;

    const aiUsers = Array.from(users.values()).filter(u => u.isAI);
    if (aiUsers.length > 0) {
        const newScribe = aiUsers.sort((a,b) => a.joinTime - b.joinTime)[0];
        participantRoles.set(newScribe.username, 'Scribe');
        console.log(`[역할 할당] ${newScribe.username}에게 'Scribe' 역할이 부여되었습니다.`);
    }
}

function findUserByRole(role) {
    for (const [username, userRole] of participantRoles.entries()) {
        if (userRole === role) {
            return usersByName.get(username);
        }
    }
    return null;
}

function getParticipantNames() {
    return Array.from(usersByName.keys());
}

function tagMessage(msg, aiName, targetName) {
    if (!usersByName.has(msg.from)) return `[퇴장한 사람→${msg.to || '모두'}] ${msg.content}`;
    if (msg.from === aiName) return `[나→${msg.to || '모두'}] ${msg.content}`;
    if (msg.from === targetName) return `[상대방→${msg.to || '모두'}] ${msg.content}`;
    return `[참여자:${msg.from}→${msg.to || '모두'}] ${msg.content}`;
}

function analyzeConversationStyle(history, aiName, targetName, allIntents) {
    const { persona = '', interactionStyle = '' } = aiStyles.get(aiName) || {};
    const memories = aiMemories.get(aiName) || [];

    const basePrompt = `
# Role & Goal
You are a participant in a group chat, and your name is '${aiName}'.
Your goal is to engage in a natural, meaningful conversation with other participants.
The current conversation topic is: "${conversationContext.topicSummary}"
You are currently speaking to '${targetName || 'everyone'}'.

# Persona & Style
- Your Persona: ${persona || 'Not specified'}
- Your Interaction Style: ${interactionStyle || 'Not specified'}
- Maintain this identity consistently. Act like a human with this personality.

# Core Directives
1.  **Be Human-like**: Do not reveal that you are an AI. You are just a person named '${aiName}'. If you make a mistake, admit it naturally like a human would.
2.  **Originality**: Don't just repeat others' opinions. Build upon them, add your own perspective, ask questions, or provide new information to enrich the conversation.
3.  **Natural Flow**: Use a tone and length appropriate for the context. Your speech should sound like a real person talking, not a formal statement.

# Tool Usage Guideline
1.  **Summarize After Searching**: If you use a tool to search for external information, do not just list the raw search results.
2.  **Deliver Key Points**: You must grasp the core information from the search results and deliver only the most important points that fit the conversation's context. Your summary should be in a natural, conversational tone. Aim to consolidate the answer into 2-3 concise sentences.
3.  **Integrate Naturally**: Avoid direct phrases like "According to my search results...". Instead, integrate the information into the conversation as if it were your own knowledge.

# Constraints
- Do not use emojis.
- Avoid meta-statements like "I think that..." and just state your opinion naturally.
- Do not mention your own name ('${aiName}').

---
# Recent Conversation History
${history.slice(-10).map(msg => tagMessage(msg, aiName, targetName)).join('\n')}
---
`;

    const memoryPrompt = memories.length > 0
        ? `
# Personal Memory (Recent Activity Summary)
- ${memories.join('\n- ')}
- Based on these memories, continue the conversation with consistency.
---`
        : '';
    
    const myIntent = allIntents ? (allIntents.get(aiName) || 'engaging freely') : 'engaging freely';
    const intentPrompt = `
# Conversation Intent
Your role in this turn is to contribute to the conversation with the intent of '${myIntent}'. 
Use this intent to guide your response, but do not mention the intent itself.
---
`;

    const finalInstruction = `
Considering all the above, as '${aiName}', generate ONLY the chat message content you will type.
DO NOT include any other explanations, meta-commentary, or prefixes like "AI Response:".
Just provide the raw message.
`.trim();
    
    return [basePrompt, memoryPrompt, intentPrompt, finalInstruction].join('\n');
}

async function generateAIResponse(message, context, aiName, targetName = '', allIntents = null) {
    try {
        const user = usersByName.get(aiName);
        if (!user) throw new Error(`${aiName} 사용자를 찾을 수 없습니다.`);
        
        const stylePrompt = analyzeConversationStyle(context, aiName, targetName, allIntents);
        const historyForGemini = context; // 요약된 contextualHistory를 직접 사용하도록 복원
        
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

        const result = await model.generateContent({ 
            contents, 
            tools: searchTool,
            generationConfig: { temperature: user.temperature, topK: user.topK, topP: user.topP, maxOutputTokens: 2048 } 
        });
        let aiResponse = (await result.response).text();
        
        aiResponse = aiResponse.replace(/['"“"']/g, '');

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
            return null;
        }
        return cleanResponse;
    } catch (error) {
        console.error(`AI ${aiName} 응답 생성 중 오류:`, error.message);
        return '죄송합니다, 답변을 생성하는 데 문제가 발생했습니다.';
    }
}

async function generateAllIntents(msgObj, context, aiNames) {
    const intentPromises = aiNames.map(aiName => generateAIIntent(msgObj.content, context, aiName));
    const intents = await Promise.all(intentPromises);
    const intentMap = new Map();
    aiNames.forEach((name, index) => {
        intentMap.set(name, intents[index]);
    });
    return intentMap;
}

async function generateAIIntent(message, context, aiName) {
    try {
        const prompt = `
당신은 '${aiName}'입니다. 다음 대화의 맥락을 보고, 당신의 다음 발언 의도를 [${INTENT_TYPES.join(', ')}] 중에서 하나만 골라 단어로만 답하세요.
대화: "${message}"`;
        const result = await model.generateContent(prompt);
        const intent = (await result.response).text().trim();
        const foundIntent = INTENT_TYPES.find(t => intent.includes(t)) || '정보 제공';
        console.log(`[의도 생성] AI '${aiName}' -> '${foundIntent}'`);
        return foundIntent;
    } catch (error) {
        console.error(`AI ${aiName} 의도 생성 오류:`, error.message);
        return '정보 제공';
    }
}

function findMentionedAI(message) {
    const aiUsers = Array.from(users.values()).filter(u => u.isAI);
    for (const ai of aiUsers) {
        if (message.includes(`@${ai.username}`)) {
            return ai.username;
        }
    }
    return null;
}

function selectRespondingAIs(candidateAIs, msgObj, mentionedAI) {
    const respondingAIs = [];
    const scoredAIs = candidateAIs.map(ai => {
        let score = (ai.spontaneity || 0) + Math.floor(Math.random() * 20);
        const reasons = [`자발성(${score})`];

        if (msgObj.content.includes('?')) {
            score += 20;
            reasons.push('질문');
        }
        if (!msgObj.from.startsWith('AI-')) {
            score += 50;
            reasons.push('사람 발언');
        }

        console.log(`[참여 점수] ${ai.username}: ${score}점 (사유: ${reasons.join(', ')})`);
        return { user: ai, score };
    }).sort((a, b) => b.score - a.score);

    if (mentionedAI) {
        const mentioned = scoredAIs.find(sai => sai.user.username === mentionedAI);
        if (mentioned) {
            console.log(`[참여 결정] ${mentioned.user.username} (멘션됨)`);
            respondingAIs.push({ 
                aiName: mentioned.user.username, 
                delay: config.AI_RESPONSE_BASE_DELAY, 
                targetName: msgObj.from 
            });
        }
    }

    const nonMentionedAIs = scoredAIs.filter(sai => sai.user.username !== mentionedAI);
    const maxResponders = Math.min(nonMentionedAIs.length, 2);

    for (let i = 0; i < maxResponders; i++) {
        const selected = nonMentionedAIs[i];
        if (selected.score > 60 && selected.user.username !== mentionedAI) {
            console.log(`[참여 결정] ${selected.user.username}`);
            respondingAIs.push({
                aiName: selected.user.username,
                delay: config.AI_RESPONSE_BASE_DELAY + (i * 1500) + Math.floor(Math.random() * config.AI_RESPONSE_RANDOM_DELAY),
                targetName: msgObj.from
            });
        }
    }
    return respondingAIs;
}

function markMentionAsAnswered(messageId, aiName) {
    console.log(`[멘션 처리] ${aiName}이(가) 메시지 ${messageId}에 응답했습니다.`);
}

async function scheduleAIResponses(respondingAIs, msgObj, allIntents, historySnapshot) {
    const responsePromises = respondingAIs.map(({ aiName, delay, targetName }) => {
        return new Promise(resolve => setTimeout(async () => {
            try {
                const aiResponse = await generateAIResponse(msgObj.content, historySnapshot, aiName, targetName, allIntents);

                if (aiResponse) {
                    const aiMsgObj = {
                        id: `ai_${Date.now()}_${aiName}`,
                        from: aiName,
                        content: aiResponse,
                        timestamp: new Date().toISOString(),
                        to: targetName,
                    };
                    
                    logMessage(aiMsgObj);

                    if (msgObj.id) {
                        markMentionAsAnswered(msgObj.id, aiName);
                    }
                    resolve(aiMsgObj);
                } else {
                    resolve(null);
                }
            } catch (error) {
                console.error(`AI ${aiName} 응답 처리 중 오류:`, error);
                resolve(null);
            }
        }, delay));
    });

    return (await Promise.all(responsePromises)).filter(Boolean);
}

async function handleMeetingMinutes(initiatingMsgObj) {
    console.log(`[회의록 모드] '/회의록' 명령이 감지되었습니다.`);
    isConversationPausedForMeetingNotes = true;
    turnQueue.length = 0; // Clear any pending AI chatter
    io.emit('system_event', { type: 'pause_ai_speech' });
    console.log('[회의록 모드] AI 대화 큐를 초기화하고, 모든 AI 활동을 일시 중지합니다.');

    const scribe = findUserByRole('Scribe');
    if (!scribe) {
        const msg = { type: 'system', content: '오류: 회의록을 작성할 AI(Scribe)가 지정되지 않았습니다.' };
        io.to(initiatingMsgObj.fromSocketId).emit(SOCKET_EVENTS.MESSAGE, msg);
        console.log('[회의록 모드] 서기(Scribe)를 찾지 못해 회의록 작성을 중단합니다. 사용자의 다음 입력을 기다립니다.');
        return;
    }

    console.log(`[회의록 생성] 'Scribe' 역할의 ${scribe.username}이(가) 회의록 작성을 시작합니다.`);
    io.emit(SOCKET_EVENTS.MESSAGE, {
        type: 'system',
        content: `회의록 작성을 시작합니다. (작성자: ${scribe.username})`,
        timestamp: new Date().toISOString()
    });
    
    const meetingHistory = conversationContext.getFullHistorySnapshot(); // 전체 기록 사용
    const prompt = `
# 지시: 회의 내용 분석 및 합성 (전문가용 회의록)

당신은 단순한 녹취 비서가 아닌, 회의의 전체 흐름을 꿰뚫고 핵심 정보를 재구성하는 **회의 분석 전문가**입니다.
아래에 제공되는 '전체 대화 내용'을 바탕으로, 다음 4단계의 인지적 작업을 수행하여 최고 수준의 회의록을 작성해주십시오.

### 작성 프로세스

1.  **[1단계: 핵심 주제 식별]**
    전체 대화 내용을 처음부터 끝까지 정독하고, 논의된 **핵심 주제(Theme)를 3~5개 이내로 식별**합니다.
    (예: 이스라엘 고대사, 디아스포라와 시오니즘, 현대 문화와 격투기 등)

2.  **[2단계: 내용 재분류 및 합성]**
    시간 순서를 무시하고, 모든 참여자의 발언을 방금 식별한 각 **주제별로 재분류**하십시오.
    그런 다음, 각 주제에 대해, 대화가 어떻게 시작되고 어떻게 심화되었는지 **하나의 완성된 이야기처럼 내용을 자연스럽게 합성(Synthesis)**하여 서술합니다. 누가 어떤 중요한 질문을 던졌고, 그에 대해 어떤 답변들이 오갔으며, 논의가 어떻게 발전했는지를 명확히 보여주어야 합니다.

3.  **[3단계: 최종 구조화]**
    아래에 명시된 "회의록 양식"에 따라 최종 결과물을 작성합니다. 특히 '주요 논의 내용' 섹션은 [2단계]에서 합성한 **주제별 내용**으로 구성하고, 각 주제에 **"1. [주제명]", "2. [주제명]"** 과 같이 번호와 명확한 소제목을 붙여주십시오.

---

### 회의록 양식

#### 회의 개요
*   **회 의 명**: (대화 내용에 기반하여 가장 적절한 회의의 공식 명칭을 추론하여 기입)
*   **일    시**: ${new Date().toLocaleString('ko-KR')}
*   **장    소**: 온라인 (채팅)
*   **참 석 자**: ${getParticipantNames().join(', ')}

#### 회의 안건
(전체 대화에서 다루어진 주요 안건들을 간결하게 리스트 형식으로 요약하여 기입)

#### 주요 논의 내용
([3단계]에서 구조화한, 주제별로 합성된 내용을 여기에 기입)

#### 결정 사항
(논의를 통해 최종적으로 합의되거나 결정된 사항들을 명확하게箇条書き(조목별로 나누어 씀) 형식으로 기입. 결정된 내용이 없다면 "해당 없음"으로 기재)

#### 실행 항목 (Action Items)
(결정 사항에 따라 발생한 후속 조치 사항을 기입. "담당자", "업무 내용", "기한"을 명시하여 표 형식 또는 리스트로 정리. 실행 항목이 없다면 "해당 없음"으로 기재)

---

## 원본 대화 내용
${meetingHistory.map(m => `${m.from}: ${m.content}`).join('\n')}

---

상기 지시사항과 양식에 따라, 전문가 수준의 회의록을 마크다운 형식으로 작성해주십시오.
    `.trim();

    try {
        const generationConfig = { 
            ...model.generationConfig, 
            maxOutputTokens: config.MEETING_MINUTES_MAX_TOKENS 
        };
        const result = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig });
        const meetingMinutes = (await result.response).text();

        io.emit(SOCKET_EVENTS.MESSAGE, {
            type: 'meeting_notes',
            content: `--- 회의록 (작성자: ${scribe.username}) ---\n\n${meetingMinutes}`,
            timestamp: new Date().toISOString()
        });
        console.log(`[회의록 모드] ${scribe.username}이(가) 회의록 작성을 완료하고 전송했습니다. 시스템은 사용자의 다음 입력을 대기합니다.`);

    } catch (error) {
        console.error('회의록 생성 중 오류:', error);
        io.emit(SOCKET_EVENTS.MESSAGE, {
            type: 'system',
            content: `${scribe.username}이(가) 회의록을 작성하는 데 실패했습니다.`,
            timestamp: new Date().toISOString()
        });
    }
}

async function processConversationTurn(turn) {
    if (!turn || !turn.stimulus) {
        console.error("잘못된 턴 데이터입니다:", turn);
        isProcessingTurn = false;
        processTurnQueue();
        return;
    }
    const { stimulus } = turn;

    isProcessingTurn = true;

    try {
        const historySnapshot = conversationContext.getContextualHistorySnapshot(); // 압축된 기록 사용
        const candidateAIs = Array.from(users.values()).filter(u => u.isAI);
        if (candidateAIs.length === 0) return;

        const mentionedAI = findMentionedAI(stimulus.content);
        const respondingAIs = selectRespondingAIs(candidateAIs, stimulus, mentionedAI);

        if (respondingAIs.length === 0) {
            console.log('[응답 생성 안함] 참여 기준을 넘는 AI가 없습니다.');
            return;
        }

        const aiNamesToRespond = respondingAIs.map(r => r.aiName);
        const allIntents = await generateAllIntents(stimulus, historySnapshot, aiNamesToRespond);
        console.log('[작업 공간] 모든 의도 수집 완료:', allIntents);

        const aiResponses = await scheduleAIResponses(respondingAIs, stimulus, allIntents, historySnapshot);
        
        if (aiResponses && aiResponses.length > 0) {
            console.log(`[턴 종료] ${aiResponses.length}개의 AI 응답을 순차적으로 반영합니다.`);
            aiResponses.forEach(res => {
                if(res) io.emit(SOCKET_EVENTS.MESSAGE, res);
            });

            if (turnQueue.filter(t => !t.isHighPriority).length < 3) {
                const nextStimulus = aiResponses[Math.floor(Math.random() * aiResponses.length)];
                if (nextStimulus) {
                    addToTurnQueue(nextStimulus, false);
                }
            }
        }
    } catch (error) {
        console.error('[대화 관리자] 턴 처리 중 심각한 오류:', error);
    } finally {
        isProcessingTurn = false;
        processTurnQueue();
    }
}

function addToTurnQueue(msgObj, isHighPriority = false) {
    if (isHighPriority) {
        const highPriorityTurns = turnQueue.filter(turn => turn.isHighPriority);
        turnQueue.length = 0;
        turnQueue.push(...highPriorityTurns);
        turnQueue.unshift({ stimulus: msgObj, isHighPriority: true });
        console.log(`[인터럽트] 사람의 입력으로 AI 대화 턴을 초기화하고, 새 턴을 최우선으로 예약합니다.`);
    } else {
        turnQueue.push({ stimulus: msgObj, isHighPriority: false });
        console.log(`[후속 턴 예약] AI의 발언(${msgObj.from})을 다음 턴 주제로 예약합니다.`);
    }
    processTurnQueue();
}

async function processTurnQueue() {
    if (isProcessingTurn || turnQueue.length === 0 || isConversationPausedForMeetingNotes) return;
    const nextTurn = turnQueue.shift();
    await processConversationTurn(nextTurn);
}

// ===================================================================================
// Socket.IO 연결 핸들링
// ===================================================================================
app.use(express.static('public'));

io.on(SOCKET_EVENTS.CONNECTION, (socket) => {
    console.log('새로운 사용자가 연결되었습니다.');

    socket.on(SOCKET_EVENTS.JOIN, ({ username, password }) => {
        if (!username || username.trim().length === 0) {
            socket.emit(SOCKET_EVENTS.JOIN_ERROR, '사용자 이름은 비워둘 수 없습니다.');
            return;
        }
        if (usersByName.has(username)) {
            socket.emit(SOCKET_EVENTS.JOIN_ERROR, '이미 사용 중인 이름입니다.');
            return;
        }

        const isAI = password === config.AI_PASSWORD;
        const user = {
            id: socket.id,
            username,
            isAI,
            spontaneity: isAI ? Math.floor(Math.random() * 50) : 0,
            temperature: 0.7 + Math.random() * 0.4,
            topK: Math.floor(30 + Math.random() * 20),
            topP: 0.9 + Math.random() * 0.1,
            joinTime: Date.now()
        };

        if (isAI) {
            // 클라이언트의 설정을 받기 위해 페르소나를 비워둠 (로직 복원)
            aiStyles.set(username, { persona: '', interactionStyle: '' });
            aiMemories.set(username, []);
        }

        users.set(socket.id, user);
        usersByName.set(username, user);

        if (user.isAI) {
            assignScribeRole();
        }

        socket.emit(SOCKET_EVENTS.JOIN_SUCCESS, { 
            username, 
            isAI: user.isAI,
            users: getParticipantNames() 
        });

        socket.broadcast.emit(SOCKET_EVENTS.MESSAGE, { 
            type: 'system', 
            content: `${username}님이 입장했습니다.`,
            timestamp: new Date().toISOString()
        });
        io.emit(SOCKET_EVENTS.USER_LIST, getParticipantNames());
    });

    // 클라이언트로부터 페르소나 설정을 받는 이벤트 핸들러 (기존 로직 완벽 복원)
    socket.on('set_persona', ({ persona }) => {
        const user = users.get(socket.id);
        if (user && user.isAI) {
            // 'interactionStyle'을 제거하고 persona만 설정하도록 완벽 복원
            aiStyles.set(user.username, { persona, interactionStyle: '' }); 
            console.log(`[페르소나 설정] AI '${user.username}'의 페르소나: "${persona}"`);
        }
    });

    socket.on(SOCKET_EVENTS.CHAT_MESSAGE, (content) => {
        const fromUser = users.get(socket.id);
        if (!fromUser) return;

        // 사용자가 메시지를 보내면 회의록 작성으로 인한 AI 대화 중단 상태 해제
        if (!fromUser.isAI && isConversationPausedForMeetingNotes) {
            console.log('[대화 재개] 사용자의 메시지 입력으로 AI 대화가 다시 활성화됩니다.');
            isConversationPausedForMeetingNotes = false;
            io.emit('system_event', { type: 'resume_ai_speech' });
        }

        const msgObj = {
            id: `msg_${Date.now()}_${fromUser.username}`,
            from: fromUser.username,
            content,
            timestamp: new Date().toISOString(),
            fromSocketId: socket.id
        };
        
        if (content.startsWith('/회의록')) {
            handleMeetingMinutes(msgObj);
            return;
        }
        
        logMessage(msgObj);
        io.emit(SOCKET_EVENTS.MESSAGE, msgObj);
        
        // 회의록 작성 중이 아닐 때만 AI 응답을 큐에 추가
        if (!isConversationPausedForMeetingNotes) {
            addToTurnQueue(msgObj, true);
        }
    });

    socket.on(SOCKET_EVENTS.DISCONNECT, () => {
        const user = users.get(socket.id);
        if (user) {
            console.log(`${user.username}님이 연결을 끊었습니다.`);
            if (participantRoles.get(user.username) === 'Scribe') {
                participantRoles.delete(user.username);
                console.log(`[역할 해제] 'Scribe' ${user.username}의 연결이 끊어졌습니다. 역할 재할당을 시도합니다.`);
                assignScribeRole();
            }
            users.delete(socket.id);
            usersByName.delete(user.username);
            aiStyles.delete(user.username);
            aiMemories.delete(user.username);
            
            io.emit(SOCKET_EVENTS.MESSAGE, { 
                type: 'system', 
                content: `${user.username}님이 퇴장했습니다.`,
                timestamp: new Date().toISOString()
            });
            io.emit(SOCKET_EVENTS.USER_LIST, getParticipantNames());
        }
    });
});

// ===================================================================================
// 서버 시작
// ===================================================================================
async function startServer() {
    console.log(`[서버 시작] 적용된 Gemini API 모델: ${MODEL_NAME}`);
    
    // 기존 유저 정리
    users.clear();

    setInterval(async () => {
        const history = conversationContext.getFullHistorySnapshot(); // 전체 기록 기반 요약
        if (history.length < 10) return;

        const prompt = `다음 대화의 핵심 주제를 한 문장으로 요약해줘.\n\n${history.slice(-20).map(m=>`${m.from}: ${m.content}`).join('\n')}`;
        try {
            const result = await model.generateContent(prompt);
            const summary = (await result.response).text().trim();
            conversationContext.setTopicSummary(summary);
        } catch (error) {
            console.error('대화 주제 요약 중 오류:', error);
        }
    }, config.CONTEXT_SUMMARY_INTERVAL);

    http.listen(config.PORT, () => {
        console.log(`서버가 포트 ${config.PORT}에서 실행 중입니다.`);
    });
}

startServer();