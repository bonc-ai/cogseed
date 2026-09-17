import React from 'react';
import { Icon } from '../foundation/Icon.jsx';

/** Native table semantics; selection is an explicitly labelled row action. */
export function DataTable({ columns = [], rows = [], sortKey, sortDir = 1, selectedIndex = -1, onSort, onSelect, label = '数据表', style }) {
  const fractions=columns.map(c=>/^[\d.]+fr$/.test(c.width || '1fr') ? parseFloat(c.width || '1fr') : 0);
  const sum=fractions.reduce((a,b)=>a+b,0);
  return <div className="cs-data-table" style={style}><table aria-label={label}>
    <colgroup>{columns.map((c,i)=><col key={c.key} style={{width: fractions[i] ? `${fractions[i]/sum*100}%` : c.width}} />)}{onSelect && <col />}</colgroup>
    <thead><tr>{columns.map(c=><th key={c.key} scope="col" aria-sort={c.sortable ? c.key===sortKey ? sortDir>0 ? 'ascending':'descending':'none':undefined} style={{textAlign:c.align || 'left'}}>
      {c.sortable ? <button type="button" className="cs-plain-action" disabled={!onSort} onClick={()=>onSort?.(c.key)}>{c.label}{c.key===sortKey && <Icon name={sortDir>0?'arrowUp':'arrowDown'} size={13} />}</button>:c.label}
    </th>)}{onSelect && <th scope="col">选择</th>}</tr></thead>
    <tbody>{rows.map((r,i)=><tr key={i} className={selectedIndex===i?'is-selected':undefined}>{columns.map(c=><td key={c.key} style={{textAlign:c.align || 'left',color:c.primary?'var(--cs-ink)':undefined}}>{r[c.key]}</td>)}
      {onSelect && <td><button type="button" className="cs-plain-action" aria-label={`选择第 ${i+1} 行`} aria-pressed={selectedIndex===i} onClick={()=>onSelect(i)}>选择</button></td>}
    </tr>)}</tbody>
  </table></div>;
}
