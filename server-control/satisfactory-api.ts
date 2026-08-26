import https from 'https';

const TIMEOUT_MS = 3000;

export type GameState = {
    onlinePlayers: number | null;
    playerLimit: number | null;
};

/**
 * Calls `QueryServerState` on the Satisfactory Dedicated Server's HTTPS API to
 * fetch the current online player count and limit.
 *
 * The server's certificate is self-signed by default, so certificate
 * verification is disabled for this request.
 *
 * @param host - Public IP or hostname of the Satisfactory dedicated server.
 * @param port - Game/API port (default 7777).
 * @param token - Optional Bearer token, required only if the server enforces auth on this call.
 * @throws If the request times out, fails, or the server responds with a non-200 status.
 */
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
