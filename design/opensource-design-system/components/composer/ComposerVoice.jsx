import React from 'react';
import { Button } from '../actions/Button.jsx';

// Existing recording surface only. Stop remains on the microphone entry.
export function ComposerVoice({ onCancel }) {
  return <div className="cs-voice-panel">
    <div className="cs-state-actions">
      <div className="cs-voice-wave" aria-hidden="true">{[8,15,24,12,30,19,10,26,16,28,12,20].map((h,i)=><span key={i} style={{height:h}}/>)}</div>
      <span role="status">正在聆听…</span>
    </div>
    <div className="cs-state-actions"><Button size="sm" onClick={onCancel}>取消录音</Button></div>
  </div>;
}
