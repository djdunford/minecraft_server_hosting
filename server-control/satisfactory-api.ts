import https from 'https';

const TIMEOUT_MS = 3000;

export type GameState = {
    onlinePlayers: number | null;
    playerLimit: number | null;
};

export const queryServerState = (host: string, port: string, token?: string): Promise<GameState> =>
    new Promise((resolve, reject) => {
        const payload = JSON.stringify({ function: 'QueryServerState', data: {} });
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload).toString(),
        };
        if (token) {
            headers.Authorization = `Bearer ${token}`;
        }

        const req = https.request(
            {
                host,
                port,
                path: '/api/v1',
                method: 'POST',
                headers,
                rejectUnauthorized: false,
                timeout: TIMEOUT_MS,
            },
            (res) => {
                let body = '';
                res.on('data', (chunk) => (body += chunk));
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`Unexpected status code ${res.statusCode}`));
                        return;
                    }
                    try {
                        const parsed = JSON.parse(body);
                        const gameState = parsed?.data?.serverGameState ?? parsed?.data?.ServerGameState ?? {};
                        const onlinePlayers = gameState.numConnectedPlayers ?? gameState.NumConnectedPlayers ?? null;
                        const playerLimit = gameState.playerLimit ?? gameState.PlayerLimit ?? null;
                        resolve({ onlinePlayers, playerLimit });
                    } catch (err) {
                        reject(err);
                    }
                });
            },
        );

        req.on('timeout', () => req.destroy(new Error('Request to Satisfactory API timed out')));
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
