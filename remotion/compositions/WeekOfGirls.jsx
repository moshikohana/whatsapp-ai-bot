import React from 'react';
import {
  AbsoluteFill, Audio, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig, continueRender, delayRender,
} from 'remotion';
import { TransitionSeries, linearTiming } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { slide } from '@remotion/transitions/slide';
import { wipe } from '@remotion/transitions/wipe';
import { flip } from '@remotion/transitions/flip';

/**
 * 🎞️ השבוע של מיה ושי — סרטון שבועי מהאלבום, עד 30 שניות.
 *
 * פתיחה עם השמות וטווח התאריכים, כל תמונה בכרטיס עם השם, היום והשעה שבה
 * נקלטה, מעברים מתחלפים בין התמונות, וסיום עם כמה תמונות היו לכל אחת.
 * בלי אימוג'י: לשרת אין גופן אימוג'י — הלבבות והנצנצים מצוירים.
 */

export const INTRO = 75, OUTRO = 80, PER_PHOTO = 78, TRANS = 18;
export const weekDuration = n => INTRO + n * PER_PHOTO + OUTRO - (n + 1) * TRANS;

const GIRL = {
  'מיה': { color: '#FF6FA5', soft: 'rgba(255,111,165,.18)' },
  'שי': { color: '#9B8CFF', soft: 'rgba(155,140,255,.18)' },
};
const colorOf = names => (names.length === 1 && GIRL[names[0]]) ? GIRL[names[0]].color : '#FFB547';

// Fonts from the project's own folder — loaded before the first frame.
const fontsReady = (() => {
  if (typeof document === 'undefined') return;
  const h = delayRender('fonts');
  const faces = [
    new FontFace('Rubik', `url(${staticFile('fonts/Rubik.ttf')})`, { weight: '300 900' }),
    new FontFace('Secular One', `url(${staticFile('fonts/SecularOne.ttf')})`),
  ];
  Promise.all(faces.map(f => f.load().then(ff => document.fonts.add(ff)))).catch(() => {}).finally(() => continueRender(h));
})();

const DISPLAY = '"Secular One", "Rubik", "Liberation Sans", sans-serif';
const BODY = '"Rubik", "Liberation Sans", sans-serif';

// ── Background: a slow warm gradient with drifting soft lights ──────
const Backdrop = () => {
  const frame = useCurrentFrame();
  const t = frame / 30;
  const dots = [
    [0.18, 0.22, 260, '#FF6FA5'], [0.82, 0.30, 320, '#9B8CFF'], [0.30, 0.78, 380, '#FFB547'],
    [0.75, 0.86, 240, '#FF6FA5'], [0.55, 0.52, 200, '#7FD6FF'],
  ];
  return (
    <AbsoluteFill style={{ background: `linear-gradient(${160 + Math.sin(t / 3) * 10}deg, #2A1540 0%, #4A1F55 45%, #7A3452 100%)` }}>
      {dots.map(([x, y, r, c], i) => (
        <div key={i} style={{
          position: 'absolute', width: r, height: r, borderRadius: '50%', background: c, opacity: 0.22,
          filter: 'blur(70px)',
          left: `calc(${x * 100}% + ${Math.sin(t / 2 + i) * 40}px - ${r / 2}px)`,
          top: `calc(${y * 100}% + ${Math.cos(t / 2.5 + i) * 50}px - ${r / 2}px)`,
        }} />
      ))}
    </AbsoluteFill>
  );
};

const Heart = ({ size = 60, color = '#FF6FA5', style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" style={style}>
    <path fill={color} d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.7 4.5c2.1 0 3.6 1.1 5.3 3 1.7-1.9 3.2-3 5.3-3 3.7 0 5.8 3.9 4.3 7.3C19.5 16.4 12 21 12 21z" />
  </svg>
);

const Sparkle = ({ x, y, delay, size = 26 }) => {
  const frame = useCurrentFrame();
  const s = interpolate((frame - delay) % 50, [0, 12, 25, 50], [0, 1, 0.2, 0], { extrapolateLeft: 'clamp' });
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ position: 'absolute', left: x, top: y, opacity: s, transform: `scale(${0.6 + s * 0.6}) rotate(${frame * 2}deg)` }}>
      <path fill="#FFE7A8" d="M12 0l2.6 9.4L24 12l-9.4 2.6L12 24l-2.6-9.4L0 12l9.4-2.6z" />
    </svg>
  );
};

// ── Intro ────────────────────────────────────────────────────────────
const Intro = ({ range, names }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const a = spring({ frame, fps, config: { damping: 14 } });
  const b = spring({ frame: frame - 10, fps, config: { damping: 12, mass: 0.8 } });
  const c = interpolate(frame, [26, 44], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', direction: 'rtl', textAlign: 'center' }}>
      <Sparkle x={250} y={640} delay={0} /><Sparkle x={800} y={700} delay={18} size={34} /><Sparkle x={690} y={1230} delay={30} />
      <div style={{ fontFamily: BODY, fontWeight: 500, fontSize: 58, color: '#FFE7D6', letterSpacing: 2, opacity: a, transform: `translateY(${(1 - a) * 40}px)` }}>
        השבוע של
      </div>
      <div style={{
        fontFamily: DISPLAY, fontSize: 170, lineHeight: 1.1, color: '#fff', marginTop: 10,
        transform: `scale(${0.6 + b * 0.4})`, opacity: b, textShadow: '0 12px 40px rgba(0,0,0,.35)',
      }}>
        {names.join(' ו')}
      </div>
      <div style={{ display: 'flex', gap: 18, marginTop: 26, opacity: c }}>
        <Heart size={54} color="#FF6FA5" style={{ transform: `scale(${1 + Math.sin(frame / 5) * 0.08})` }} />
        <Heart size={54} color="#9B8CFF" style={{ transform: `scale(${1 + Math.cos(frame / 5) * 0.08})` }} />
      </div>
      <div style={{ fontFamily: BODY, fontSize: 44, color: '#FFD6E6', marginTop: 26, opacity: c }}>{range}</div>
    </AbsoluteFill>
  );
};

// ── One photo ────────────────────────────────────────────────────────
const PhotoCard = ({ p, i, total }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const tilt = i % 2 ? 2.2 : -2.2;
  const kb = interpolate(frame, [0, PER_PHOTO], [1.02, 1.12]);
  const pan = interpolate(frame, [0, PER_PHOTO], [i % 2 ? -18 : 18, 0]);
  const cap = spring({ frame: frame - 12, fps, config: { damping: 15 } });
  const col = colorOf(p.names);
  return (
    <AbsoluteFill style={{ direction: 'rtl' }}>
      {/* the same photo, blurred, fills the frame behind the card */}
      <AbsoluteFill style={{ overflow: 'hidden' }}>
        <Img src={p.src} style={{ width: '100%', height: '100%', objectFit: 'cover', filter: 'blur(38px) saturate(1.3)', transform: 'scale(1.25)', opacity: 0.75 }} />
        <AbsoluteFill style={{ background: 'linear-gradient(180deg, rgba(20,8,30,.55), rgba(20,8,30,.25) 40%, rgba(20,8,30,.7))' }} />
      </AbsoluteFill>

      {/* progress dots */}
      <div style={{ position: 'absolute', top: 90, width: '100%', display: 'flex', justifyContent: 'center', gap: 12 }}>
        {Array.from({ length: total }).map((_, k) => (
          <div key={k} style={{ width: k === i ? 38 : 12, height: 12, borderRadius: 6, background: k === i ? col : 'rgba(255,255,255,.35)' }} />
        ))}
      </div>

      {/* the polaroid */}
      <div style={{
        position: 'absolute', left: 90, right: 90, top: 250, bottom: 330,
        background: '#FFFDF8', borderRadius: 34, padding: 22, paddingBottom: 170,
        boxShadow: '0 40px 90px rgba(0,0,0,.45)', transform: `rotate(${tilt}deg)`,
      }}>
        <div style={{ width: '100%', height: '100%', borderRadius: 20, overflow: 'hidden' }}>
          <Img src={p.src} style={{ width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${kb}) translateX(${pan}px)` }} />
        </div>
        {/* caption: who, and when */}
        <div style={{
          position: 'absolute', left: 30, right: 30, bottom: 26, height: 120,
          display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'flex-start',
          opacity: cap, transform: `translateY(${(1 - cap) * 30}px)`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <Heart size={40} color={col} />
            <span style={{ fontFamily: DISPLAY, fontSize: 64, color: '#2A1540' }}>{p.names.join(' ו')}</span>
          </div>
          <div style={{ fontFamily: BODY, fontSize: 36, color: '#7A5A6E', marginTop: 4 }}>{p.when}</div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ── Outro ────────────────────────────────────────────────────────────
const Outro = ({ counts, sign, credit }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const a = spring({ frame, fps, config: { damping: 13 } });
  const b = interpolate(frame, [18, 36], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', direction: 'rtl', textAlign: 'center' }}>
      <Sparkle x={220} y={700} delay={4} size={34} /><Sparkle x={820} y={620} delay={20} />
      <Heart size={130} color="#FF6FA5" style={{ transform: `scale(${a}) rotate(${(1 - a) * -30}deg)` }} />
      <div style={{ fontFamily: DISPLAY, fontSize: 120, color: '#fff', marginTop: 20, opacity: a, textShadow: '0 12px 40px rgba(0,0,0,.35)' }}>{sign}</div>
      <div style={{ display: 'flex', gap: 26, marginTop: 40, opacity: b }}>
        {counts.map(c => (
          <div key={c.name} style={{ background: (GIRL[c.name] || {}).soft || 'rgba(255,255,255,.12)', border: `3px solid ${(GIRL[c.name] || {}).color || '#fff'}`, borderRadius: 999, padding: '14px 34px' }}>
            <span style={{ fontFamily: DISPLAY, fontSize: 52, color: '#fff' }}>{c.name}</span>
            <span style={{ fontFamily: BODY, fontSize: 40, color: '#FFE7D6', marginRight: 14 }}>{c.n} תמונות</span>
          </div>
        ))}
      </div>
      <div style={{ fontFamily: BODY, fontSize: 30, color: 'rgba(255,231,214,.7)', marginTop: 60, opacity: b }}>נאסף באהבה · בוטי</div>
      {credit ? <div style={{ fontFamily: BODY, fontSize: 20, color: 'rgba(255,231,214,.45)', marginTop: 14, opacity: b, direction: 'ltr' }}>{credit}</div> : null}
    </AbsoluteFill>
  );
};

// ── The whole film ───────────────────────────────────────────────────
const TRANSITIONS = [
  () => fade(),
  () => slide({ direction: 'from-left' }),
  () => wipe({ direction: 'from-top-left' }),
  () => flip({ direction: 'from-right' }),
  () => slide({ direction: 'from-bottom' }),
];

// "הסרטון מאוד יפה, לא שמעתי שמע" (13.9) — a track under it, faded at both ends.
const Music = ({ file }) => {
  const { durationInFrames } = useVideoConfig();
  return (
    <Audio src={staticFile('music/' + file)}
      volume={f => interpolate(f, [0, 18, durationInFrames - 45, durationInFrames - 1], [0, 0.75, 0.75, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })} />
  );
};

export const WeekOfGirls = ({ photos = [], range = '', names = ['מיה', 'שי'], counts = [], sign = 'שבת שלום', music = null, credit = '' }) => {
  const timing = linearTiming({ durationInFrames: TRANS });
  return (
    <AbsoluteFill>
      <Backdrop />
      {music ? <Music file={music} /> : null}
      <TransitionSeries>
        <TransitionSeries.Sequence durationInFrames={INTRO}><Intro range={range} names={names} /></TransitionSeries.Sequence>
        {photos.map((p, i) => (
          <React.Fragment key={i}>
            <TransitionSeries.Transition presentation={TRANSITIONS[i % TRANSITIONS.length]()} timing={timing} />
            <TransitionSeries.Sequence durationInFrames={PER_PHOTO}><PhotoCard p={p} i={i} total={photos.length} /></TransitionSeries.Sequence>
          </React.Fragment>
        ))}
        <TransitionSeries.Transition presentation={fade()} timing={timing} />
        <TransitionSeries.Sequence durationInFrames={OUTRO}><Outro counts={counts} sign={sign} credit={credit} /></TransitionSeries.Sequence>
      </TransitionSeries>
    </AbsoluteFill>
  );
};
