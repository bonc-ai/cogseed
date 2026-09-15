import React from 'react';
import { csIcons } from './lucide-icons.js';

// Generated from the pinned official SVGs in assets/lucide at build time.
export { csIcons };

export function Icon({ name, size = 'var(--cs-icon-size)', strokeWidth = 'var(--cs-icon-stroke)', color = 'currentColor', style, ...rest }) {
  const body = Object.prototype.hasOwnProperty.call(csIcons, name) ? csIcons[name] : null;
  if (!body) {
    if (typeof window !== 'undefined' && window.RAYMOND_DESIGN_DEBUG) console.warn(`Unknown design icon: ${name}`);
    return null;
  }
  return (
    <svg width={typeof size === "number" ? size : undefined} height={typeof size === "number" ? size : undefined} viewBox="0 0 24 24" fill="none" stroke={color}
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width:size, height:size, strokeWidth, flex: 'none', display: 'block', ...style }}
      dangerouslySetInnerHTML={{ __html: body[0] }} {...rest} />
  );
}
