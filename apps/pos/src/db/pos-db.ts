import { openDB, type DBSchema } from 'idb';
export interface LocalProduct { id:string; sku:string; barcode:string|null; name:string; salePrice:string; availableQuantity:string; taxRate:string; revision:string; updatedAt:string; }
export interface OutboxCommand { commandId:string; sequence:number; type:'POS_SALE'; payload:unknown; status:'pending'|'sending'|'conflict'|'dead_letter'; createdAt:string; retryCount:number; lastError:string|null; }
interface PosDb extends DBSchema {
 products:{key:string;value:LocalProduct;indexes:{sku:string;barcode:string}};
 outbox:{key:string;value:OutboxCommand;indexes:{sequence:number;status:string}};
 state:{key:string;value:{key:string;value:string}};
}
let dbPromise:ReturnType<typeof openDB<PosDb>>|null=null;
export function getPosDb(){if(!dbPromise){dbPromise=openDB<PosDb>('axiom-pos',1,{upgrade(db){const products=db.createObjectStore('products',{keyPath:'id'});products.createIndex('sku','sku',{unique:true});products.createIndex('barcode','barcode');const outbox=db.createObjectStore('outbox',{keyPath:'commandId'});outbox.createIndex('sequence','sequence',{unique:true});outbox.createIndex('status','status');db.createObjectStore('state',{keyPath:'key'});}});}return dbPromise;}
