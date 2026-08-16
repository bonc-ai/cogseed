import { describe, expect, it } from 'vitest';
import { P3394WebSocketChannel } from '../../../../src/main/features/p3394';
describe('P3394 websocket channel',()=>{it('is opt-in and requires auth',async()=>{await expect(new P3394WebSocketChannel({enabled:false}).listen()).rejects.toThrow(/disabled/); await expect(new P3394WebSocketChannel({enabled:true}).listen()).rejects.toThrow(/auth_required/); await expect(new P3394WebSocketChannel({enabled:true,auth_token:'t'}).listen()).resolves.toBeUndefined();});});
