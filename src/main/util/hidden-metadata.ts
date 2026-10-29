/** Streaming filter for the machine-only context patch envelope. Retain tag
 * prefixes across chunks so even an unfinished/malformed patch never exposes
 * its JSON. Similar-looking prose tags are left untouched. */
function createContextPatchFilter() {
  const open = '<context-patch>';
  const close = '</context-patch>';
  let pending = '';
  let hidden = false;
  return {
    push(piece: string): string {
      pending += piece;
      let visible = '';
      while (pending) {
        const marker = hidden ? close : open;
        const lower = pending.toLowerCase();
        const index = lower.indexOf(marker);
        if (index >= 0) {
          if (!hidden) visible += pending.slice(0, index);
          pending = pending.slice(index + marker.length);
          hidden = !hidden;
          continue;
        }
        let keep = 0;
        for (let size = Math.min(marker.length - 1, pending.length); size > 0; size--) {
          if (marker.startsWith(lower.slice(-size))) { keep = size; break; }
        }
        if (!hidden) visible += pending.slice(0, pending.length - keep);
        pending = keep ? pending.slice(-keep) : '';
        break;
      }
      return visible;
    },
    finish(): string {
      // An opening protocol prefix at EOF is also internal, never prose.
      const text = hidden || open.startsWith(pending.toLowerCase()) ? '' : pending;
      pending = ''; hidden = false;
      return text;
    },
  };
}

/** Buffer result-marker prefixes too; final status parsing still receives the
 * original marker, while no chunk of it is published as visible prose. */
export function createHiddenMetadataFilter(options: { preserveResultMarkers?: boolean } = {}) {
  const patches = createContextPatchFilter();
  let pending = '';
  const prefixes = ['<agent-result', '<commander-result', '</agent-result', '</commander-result'];
  const filterMarkers = (text: string): string => {
    if (options.preserveResultMarkers) return text;
    pending += text;
    let visible = '';
    while (pending) {
      const index = pending.indexOf('<');
      if (index < 0) { visible += pending; pending = ''; break; }
      visible += pending.slice(0, index); pending = pending.slice(index);
      const lower = pending.toLowerCase();
      if (prefixes.some(prefix => prefix.startsWith(lower))) break;
      const prefix = prefixes.find(prefix => lower.startsWith(prefix) && /[\s/>]/.test(lower[prefix.length] || ''));
      if (prefix) {
        const end = pending.indexOf('>');
        if (end < 0) break;
        pending = pending.slice(end + 1);
      } else { visible += '<'; pending = pending.slice(1); }
    }
    return visible;
  };
  return {
    push: (piece: string) => filterMarkers(patches.push(piece)),
    finish: () => { const visible = filterMarkers(patches.finish()); pending = ''; return visible; },
  };
}

export function stripHiddenMetadata(text: string): string {
  // The owner consumes result status from the final, non-visible envelope.
  const filter = createHiddenMetadataFilter({ preserveResultMarkers: true });
  return filter.push(text) + filter.finish();
}
