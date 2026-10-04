import type { Health } from '../lib/api';

/**
 * The provenance panel.
 *
 * This exists because the product's central claim is "nothing leaves this
 * machine". A claim like that should be checkable, so every part of it is shown
 * rather than asserted: which weights are loaded, under which licence, and
 * whether they are on disk right now.
 */
export function ProvenancePanel({ health, error }: { health: Health | null; error: string | null }) {
  if (error) {
    return (
      <section className="provenance banner error">
        <strong>Cannot reach the local service.</strong>
        <span>{error}</span>
      </section>
    );
  }
  if (!health) {
    return (
      <section className="provenance">
        <p className="note">Checking what is running…</p>
      </section>
    );
  }

  return (
    <section className="provenance">
      <div className="prov-top">
        <div>
          <span className="k">runtime</span>
          <span className="v">{health.inference.runtime}</span>
        </div>
        <div>
          <span className="k">device</span>
          <span className="v">{health.inference.device}</span>
        </div>
        <div>
          <span className="k">third-party AI APIs</span>
          <span className="v good">{health.inference.remoteApisUsed.length === 0 ? 'none' : health.inference.remoteApisUsed.join(', ')}</span>
        </div>
        <div>
          <span className="k">weights on disk</span>
          <span className={`v ${health.inference.defaultsCachedLocally ? 'good' : 'warn'}`}>
            {health.inference.defaultsCachedLocally ? 'ready, runs offline' : 'not yet fetched'}
          </span>
        </div>
      </div>

      {health.slots.map((slot) => (
        <div key={slot.slot} className="prov-slot">
          <h3>
            <code>{slot.slot}</code> — {slot.purpose}
          </h3>
          <ul>
            {slot.models.map((m) => (
              <li key={m.id} className={m.id === slot.defaultModelId ? 'default' : ''}>
                <span className="name">{m.label}</span>
                <span className="lic">
                  <a href={m.licenseUrl} target="_blank" rel="noreferrer">
                    {m.license}
                  </a>
                </span>
                <span className="dtype">
                  {m.dtype} · ~{m.approxMb}MB
                </span>
                <span className={`state ${m.cachedLocally ? 'good' : 'warn'}`}>
                  {m.cachedLocally ? (m.loaded ? `loaded ${m.loadMs}ms` : 'cached') : 'not fetched'}
                </span>
                {m.licenseNote && <span className="why">{m.licenseNote}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}