export function EnterpriseTable({rows}:{rows:Array<Record<string,unknown>>}){
  if(rows.length===0) return <div className="card muted">No records found.</div>;
  const columns=Object.keys(rows[0]!).filter(c=>c!=='id');
  return <div style={{overflowX:'auto'}}><table><thead><tr>{columns.map(c=><th key={c}>{c.replaceAll('_',' ')}</th>)}</tr></thead><tbody>{rows.map((r,i)=><tr key={String(r.id??i)}>{columns.map(c=><td key={c}>{r[c]==null?'—':String(r[c])}</td>)}</tr>)}</tbody></table></div>;
}
