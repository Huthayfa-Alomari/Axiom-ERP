import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from 'pg';

function checksum(sql:string){return createHash('sha256').update(sql).digest('hex');}
async function main(){
  const url=process.env.MIGRATION_DATABASE_URL;if(!url)throw new Error('MIGRATION_DATABASE_URL is required');
  const dir=resolve(process.cwd(),'database/migrations');const files=(await readdir(dir)).filter(f=>/^\d{4}_.+\.sql$/.test(f)).sort();
  const client=new Client({connectionString:url});await client.connect();
  try{
    await client.query("select pg_advisory_lock(hashtext('axiom_erp_migrations'))");
    await client.query("create table if not exists public.schema_migrations(filename varchar(255) primary key,checksum varchar(64) not null,applied_at timestamptz not null default clock_timestamp())");
    const rows=await client.query<{filename:string;checksum:string}>('select filename,checksum from public.schema_migrations');const applied=new Map(rows.rows.map(r=>[r.filename,r.checksum]));
    for(const file of files){const script=await readFile(resolve(dir,file),'utf8');const digest=checksum(script);const old=applied.get(file);if(old){if(old!==digest)throw new Error(`Applied migration modified: ${file}`);console.log(`SKIP ${file}`);continue;}console.log(`APPLY ${file}`);await client.query(script);await client.query('insert into public.schema_migrations(filename,checksum) values($1,$2)',[file,digest]);}
  } finally {await client.query("select pg_advisory_unlock(hashtext('axiom_erp_migrations'))").catch(()=>undefined);await client.end();}
}
void main();
