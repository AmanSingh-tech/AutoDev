import { ImageResponse } from 'next/og';

export const alt = 'AutoDev: hand off coding tasks, get back pull requests';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/** The preview card shown when a link to AutoDev is shared (Slack, LinkedIn, email…). */
export default function OpenGraphImage() {
  const steps = ['Plan', 'Design', 'Code', 'Tests', 'Pull request'];
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: 72, background: 'linear-gradient(135deg, #0c0c12 0%, #17153a 60%, #2a2470 100%)', color: '#f4f4f6', fontFamily: 'sans-serif' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <div style={{ width: 56, height: 56, borderRadius: 14, background: '#6366f1', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 34, fontWeight: 700 }}>A</div>
          <div style={{ fontSize: 38, fontWeight: 700 }}>AutoDev</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          <div style={{ fontSize: 68, fontWeight: 700, lineHeight: 1.08, maxWidth: 980 }}>Hand off coding tasks. Get back pull requests you’d have written.</div>
          <div style={{ fontSize: 30, color: '#b9b8d6', maxWidth: 900 }}>An AI agent that plans, codes, runs your tests and opens the PR on GitHub as you. You approve every step.</div>
        </div>
        <div style={{ display: 'flex', gap: 14 }}>
          {steps.map((s, i) => (
            <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 20px', borderRadius: 999, background: i === steps.length - 1 ? '#6366f1' : 'rgba(255,255,255,0.08)', fontSize: 24 }}>
              <div style={{ width: 24, height: 24, borderRadius: 999, background: i === steps.length - 1 ? '#fff' : '#6366f1', color: i === steps.length - 1 ? '#6366f1' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 700 }}>{i + 1}</div>
              {s}
            </div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}
