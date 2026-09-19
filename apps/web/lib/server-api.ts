export async function apiGet<T>(path:string):Promise<T>{
  const response=await fetch(`${process.env.API_INTERNAL_URL ?? 'http://localhost:3001'}${path}`,{cache:'no-store'});
  if(!response.ok) throw new Error(`API GET ${path} failed: ${response.status}`);
  return response.json() as Promise<T>;
}
