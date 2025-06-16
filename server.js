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

            // AI 사용자인 경우 응답 생성
            if (isAIUser.get(socket.id)) {
                try {
                    console.log('AI 응답 생성 시도');
                    
                    // 현재 대화방의 모든 사용자 이름 목록 생성
                    const userList = Array.from(users.values()).join(', ');
                    
                    // AI의 이름 가져오기
                    const aiUsername = username;

                    const completion = await openai.createChatCompletion({
                        model: "gpt-3.5-turbo",
                        messages: [
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
7. 당신은 진짜 사람처럼 행동해야 합니다.`
                            },
                            ...conversationHistory.map(msg => ({
                                role: msg.role,
                                content: msg.content,
                                name: msg.username
                            }))
                        ],
                        max_tokens: 150,
                        temperature: 0.8,
                        presence_penalty: 0.6,
                        frequency_penalty: 0.3
                    });

                    const aiResponse = completion.data.choices[0].message.content;
                    console.log('AI 응답:', aiResponse);
                    
                    // AI 응답을 대화 기록에 추가
                    conversationHistory.push({
                        role: 'assistant',
                        content: aiResponse,
                        username: aiUsername
                    });

                    // AI 응답 전송
                    io.emit('chat message', {
                        type: 'user',
                        username: username,
                        message: aiResponse
                    });
                } catch (error) {
                    console.error('OpenAI API 오류:', error);
                    // 에러 발생 시 사용자에게 알림
                    io.emit('chat message', {
                        type: 'system',
                        message: 'AI 응답 생성 중 오류가 발생했습니다.'
                    });
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