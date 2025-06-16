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
            console.log('AI 인증 성공');
        } else {
            socket.emit('ai_verified', false);
            console.log('AI 인증 실패');
        }
    });

    // 사용자 참여 처리
    socket.on('join', (username) => {
        users.set(socket.id, username);
        connectedUsers++;
        console.log(`${username}님이 입장하셨습니다. 현재 접속자 수: ${connectedUsers}`);
        
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
            // 일반 메시지 전송
            io.emit('chat message', {
                type: 'user',
                username: username,
                message: msg
            });

            // AI 사용자인 경우 응답 생성
            if (isAIUser.get(socket.id)) {
                try {
                    console.log('AI 응답 생성 시도');
                    const completion = await openai.createChatCompletion({
                        model: "gpt-3.5-turbo",
                        messages: [
                            {
                                role: "system",
                                content: "당신은 채팅방에서 자연스럽게 대화하는 사용자입니다. 짧고 자연스러운 대화를 나누세요."
                            },
                            {
                                role: "user",
                                content: msg
                            }
                        ],
                        max_tokens: 100
                    });

                    const aiResponse = completion.data.choices[0].message.content;
                    console.log('AI 응답:', aiResponse);
                    
                    // AI 응답 전송
                    io.emit('chat message', {
                        type: 'user',
                        username: username,
                        message: aiResponse
                    });
                } catch (error) {
                    console.error('OpenAI API 오류:', error);
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