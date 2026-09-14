import React from 'react';

// Settings-specific grouping: section spacing owns hierarchy; controls own behavior.
export function SettingsSection({ title, actions, children }) {
  return <section aria-label={title} className="cs-settings-section">
    <header className="cs-settings-section__header">
      <h2 className="cs-settings-section__title">{title}</h2>
      {actions ? <div className="cs-settings-section__actions">{actions}</div> : null}
    </header>
    <div className="cs-settings-section__body">{children}</div>
  </section>;
}
