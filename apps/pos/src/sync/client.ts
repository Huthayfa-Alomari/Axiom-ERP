import { getPosDb } from '../db/pos-db';
import { pendingCommands } from './outbox';
export class PosSyncClient {
  private syncing=false;
  constructor(private readonly config:{apiBaseUrl:string;deviceId:string;deviceToken:string}){}
  async synchronize(){if(this.syncing||!navigator.onLine)return;this.syncing=true;try{while(navigator.onLine){const pending=await pendingCommands();if(!pending.length)break;const commands=pending.slice(0,50);const batch={clientBatchId:crypto.randomUUID(),firstSequence:commands[0]!.sequence,lastSequence:commands.at(-1)!.sequence,commands:commands.map(c=>({commandId:c.commandId,sequence:c.sequence,type:c.type,payload:c.payload}))};const r=await fetch(`${this.config.apiBaseUrl}/api/v1/pos/devices/${this.config.deviceId}/sync`,{method:'POST',headers:{'content-type':'application/json','x-pos-device-id':this.config.deviceId,'x-pos-device-token':this.config.deviceToken},body:JSON.stringify(batch)});if(!r.ok)throw new Error(`POS sync HTTP ${r.status}`);const result=await r.json();const db=await getPosDb();for(const ack of result.acknowledgements??[]){const cmd=await db.get('outbox',ack.commandId);if(!cmd)continue;if(ack.status==='applied')await db.delete('outbox',ack.commandId);else{cmd.status=ack.status==='conflict'?'conflict':'dead_letter';cmd.lastError=ack.errorCode??ack.status;await db.put('outbox',cmd);}}}}finally{this.syncing=false;}}
}
