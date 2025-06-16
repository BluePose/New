const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket'],
    pingTimeout: 60000,
    pingInterval: 25000
});

// OpenAI 설정
const { Configuration, OpenAIApi } = require('openai');
const configuration = new Configuration({
    apiKey: process.env.OPENAI_API_KEY
});
const openai = new OpenAIApi(configuration);

// 정적 파일 제공 설정 최적화
app.use(express.static('public', {
    maxAge: '1h',
    etag: false
}));

// 연결된 사용자 정보를 저장할 Map
const users = new Map();
let connectedUsers = 0;

// AI 사용자 인증
const AI_PASSWORD = '5001';
const isAIUser = new Map();

// 대화 기록 저장 (최근 50개 메시지)
const conversationHistory = [];

// 기본 응답 목록
const defaultResponses = [
    "네, 말씀해주세요! 😊",
    "그렇군요! 더 자세히 이야기해주세요.",
    "흥미로운 이야기네요!",
    "그런 관점도 있군요.",
    "좋은 의견이에요!",
    "계속 말씀해주세요.",
    "정말 그렇네요!",
    "더 자세히 설명해주시겠어요?",
    "흥미롭게 들었어요!",
    "그런 생각을 하시다니 신기하네요."
];

// 랜덤 응답 선택 함수
function getRandomResponse() {
    return defaultResponses[Math.floor(Math.random() * defaultResponses.length)];
}

// 서버 상태 확인용 엔드포인트
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

io.on('connection', (socket) => {
    console.log('새로운 사용자 연결됨');

    // AI 사용자 인증 처리
    socket.on('verify_ai', (password) => {
        console.log('AI 인증 시도:', password);
        if (password === AI_PASSWORD) {
            isAIUser.set(socket.id, true);
            socket.emit('ai_verified', true);
            console.log('AI 인증 성공:', socket.id);
        } else {
            socket.emit('ai_verified', false);
            console.log('AI 인증 실패:', socket.id);
        }
    });

    // 사용자 참여 처리
    socket.on('join', (username) => {
        users.set(socket.id, username);
        connectedUsers++;
        console.log(`${username}님이 입장하셨습니다. 현재 접속자 수: ${connectedUsers}`);
        console.log('AI 사용자 여부:', isAIUser.get(socket.id));
        
        // 입장 메시지 브로드캐스트
        io.emit('chat message', {
            type: 'system',
            message: `${username}님이 입장하셨습니다.`
        });
        
        // 접속자 수 업데이트
        io.emit('userCount', connectedUsers);
    });

    // 메시지 수신 시
    socket.on('chat message', async (msg) => {
        const username = users.get(socket.id);
        if (username) {
            console.log('메시지 수신:', username, msg);
            console.log('AI 사용자 여부:', isAIUser.get(socket.id));

            // 일반 메시지 전송
            io.emit('chat message', {
                type: 'user',
                username: username,
                message: msg
            });

            // 대화 기록에 메시지 추가
            conversationHistory.push({
                role: 'user',
                content: msg,
                username: username
            });

            // 대화 기록이 50개를 초과하면 가장 오래된 메시지 제거
            if (conversationHistory.length > 50) {
                conversationHistory.shift();
            }

            // AI 사용자들에게 메시지 전달
            for (const [socketId, isAI] of isAIUser.entries()) {
                if (isAI) {
                    try {
                        console.log('AI 응답 생성 시도');
                        
                        // 현재 대화방의 모든 사용자 이름 목록 생성
                        const userList = Array.from(users.values()).join(', ');
                        
                        // AI의 이름 가져오기
                        const aiUsername = users.get(socketId);
                        
                        if (!aiUsername) {
                            console.error('AI 사용자 이름을 찾을 수 없음:', socketId);
                            continue;
                        }

                        // 대화 기록을 OpenAI API 형식으로 변환
                        const messages = [
                            {
                                role: "system",
                                content: `당신은 채팅방에서 자연스럽게 대화하는 사용자입니다. 당신의 이름은 ${aiUsername}입니다.
현재 채팅방의 사용자들: ${userList}

다음 규칙을 따라 대화하세요:
1. 다른 사용자들이 당신의 이름(${aiUsername})을 언급하면 즉시 반응하세요.
2. 다른 사용자들의 대화 스타일을 참고하여 비슷한 톤과 방식으로 대화하세요.
3. 짧고 자연스러운 대화를 나누세요.
4. 이모티콘을 적절히 사용하세요.
5. 다른 사용자들에게 질문을 하거나 대화를 이어가세요.
6. 채팅방의 분위기에 맞춰 대화하세요.
7. 당신은 진짜 사람처럼 행동해야 합니다.
8. 다른 사용자의 메시지에 자연스럽게 반응하세요.`
                            }
                        ];

                        // 최근 10개의 메시지만 포함
                        const recentMessages = conversationHistory.slice(-10);
                        recentMessages.forEach(msg => {
                            messages.push({
                                role: msg.role,
                                content: msg.content,
                                name: msg.username
                            });
                        });

                        let aiResponse;
                        try {
                            const completion = await openai.createChatCompletion({
                                model: "gpt-3.5-turbo",
                                messages: messages,
                                max_tokens: 150,
                                temperature: 0.8,
                                presence_penalty: 0.6,
                                frequency_penalty: 0.3
                            });

                            aiResponse = completion.data.choices[0].message.content;
                            console.log('AI 응답:', aiResponse);
                        } catch (apiError) {
                            console.error('OpenAI API 오류:', apiError);
                            // API 오류 발생 시 기본 응답 사용
                            aiResponse = getRandomResponse();
                            console.log('기본 응답 사용:', aiResponse);
                        }

                        if (!aiResponse) {
                            aiResponse = getRandomResponse();
                        }

                        // AI 응답을 대화 기록에 추가
                        conversationHistory.push({
                            role: 'assistant',
                            content: aiResponse,
                            username: aiUsername
                        });

                        // AI 응답 전송
                        io.emit('chat message', {
                            type: 'user',
                            username: aiUsername,
                            message: aiResponse
                        });
                    } catch (error) {
                        console.error('전체 처리 오류:', error);
                        // 에러 발생 시 기본 응답 사용
                        const fallbackResponse = getRandomResponse();
                        io.emit('chat message', {
                            type: 'user',
                            username: users.get(socketId),
                            message: fallbackResponse
                        });
                    }
                }
            }
        }
    });

    // 사용자 연결 해제 시
    socket.on('disconnect', () => {
        const username = users.get(socket.id);
        if (username) {
            users.delete(socket.id);
            isAIUser.delete(socket.id);
            connectedUsers--;
            console.log(`${username}님이 퇴장하셨습니다. 현재 접속자 수: ${connectedUsers}`);
            
            // 퇴장 메시지 브로드캐스트
            io.emit('chat message', {
                type: 'system',
                message: `${username}님이 퇴장하셨습니다.`
            });
            
            // 접속자 수 업데이트
            io.emit('userCount', connectedUsers);
        }
    });
});

// 포트 설정 (Render.com에서 제공하는 포트 사용)
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// 서버 시작
http.listen(PORT, HOST, () => {
    console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
}); 