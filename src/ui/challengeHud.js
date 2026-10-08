// Challenge HUD (contract f.3): the glass pieces of a challenge run, reading state.challenge (written
// by src/gameplay/challenges.js every frame) and the typed challenge events:
//   - the start prompt near a registered start gate: the course name, the distance, this craft's best
//     time and medal, and the challengeStart key (Y by default);
//   - the gate arrow: a screen-edge chevron toward the next gate while it is off screen, a distance
//     tag on it while it is in view, and a glowing 3D frame in the gate itself (circle or rectangle);
//   - the timer card: elapsed time, gate count, penalties, the medal the run is on pace for, the last
//     split coloured green (ahead of this craft's best) or red (behind), a rival's lead;
//   - the missed-gate flash (and a sensor miss: a kite string) on the timer card;
//   - the medal toast on challengeFinished.
// The ring course keeps its own Phase 2 HUD (it runs on the challenge core as a legacy course and is
// not shown in state.challenge).
//
// System 'challengeHud' (after 'ui'). DOM text is rewritten only when its value changes; positions
// move only when they change by a quarter pixel. The 3D marker is a scene child at the gate's world
// position, so the render origin (scene.position) needs nothing; screen projection converts the gate
// to the render frame through ctx.origin when one exists (contract a.6).
import './challengeHud.css';
import { keyLabel } from '../input/bindings.js';

/** Seconds the medal toast stays up, and the gate flash. */
const TOAST_SECONDS = 6;
const FLASH_SECONDS = 1.1;
/** Seconds between timer text refreshes (tenths are shown). */
const TIMER_STEP = 0.05;
/** Margin (CSS px) the arrow keeps from the screen edges. */
const EDGE_MARGIN = 56;
const MEDAL_COLORS = Object.freeze({ gold: 0xf3c77a, silver: 0xd5dde6, bronze: 0xd99a6c, none: 0x8fd3d6 });
const MEDAL_LABELS = Object.freeze({ gold: 'Gold', silver: 'Silver', bronze: 'Bronze', none: 'No medal' });

/** "m:ss.t" for seconds. */
export function formatChallengeTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  const whole = Math.floor(rest);
  const tenths = Math.min(9, Math.floor((rest - whole) * 10));
  return `${minutes}:${String(whole).padStart(2, '0')}.${tenths}`;
}

/** "+1.2 s" / "-0.8 s" for a split delta. */
export function formatSplitDelta(delta) {
  if (!Number.isFinite(delta)) return '';
  const tenths = Math.round(delta * 10) / 10;
  return `${tenths > 0 ? '+' : tenths < 0 ? '-' : '±'}${Math.abs(tenths).toFixed(1)} s`;
}

function formatDistance(metres) {
  if (!Number.isFinite(metres)) return '';
  if (metres < 950) return `${Math.max(0, Math.round(metres / 10) * 10)} m`;
  const kilometres = metres / 1000;
  return kilometres < 9.95 ? `${kilometres.toFixed(1)} km` : `${Math.round(kilometres)} km`;
}

function cssColor(hex) {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

export function createChallengeHud(ctx) {
  const { THREE, TSL, scene, camera, state, bus } = ctx;
  const root = document.getElementById('ui-root');
  if (!root) throw new Error('DRIFTWING challenge HUD: the #ui-root element is missing from the page.');

  // ---- DOM ------------------------------------------------------------------------------------------
  const prompt = document.createElement('div');
  prompt.className = 'dw-challenge-prompt glass';
  prompt.setAttribute('role', 'status');
  prompt.innerHTML = [
    '<span class="dw-challenge-label">Challenge</span>',
    '<span class="dw-challenge-prompt-name"></span>',
    '<span class="dw-challenge-prompt-detail"></span>',
    '<span class="dw-challenge-prompt-key"><kbd></kbd><span>start</span></span>',
  ].join('');
  const timer = document.createElement('div');
  timer.className = 'dw-challenge-timer glass';
  timer.setAttribute('role', 'timer');
  timer.innerHTML = [
    '<div class="dw-challenge-timer-head"><span class="dw-challenge-label"></span><span class="dw-challenge-pace"><i></i><span></span></span></div>',
    '<div class="dw-challenge-time">0:00.0</div>',
    '<div class="dw-challenge-row"><span class="dw-challenge-gates"></span><span class="dw-challenge-penalty"></span></div>',
    '<div class="dw-challenge-split"><span class="dw-challenge-split-time"></span><span class="dw-challenge-split-delta"></span></div>',
    '<div class="dw-challenge-rival"></div>',
    '<div class="dw-challenge-flash"></div>',
  ].join('');
  const arrow = document.createElement('div');
  arrow.className = 'dw-challenge-arrow';
  arrow.innerHTML = '<span class="dw-challenge-chevron"></span><span class="dw-challenge-arrow-distance"></span>';
  const toast = document.createElement('div');
  toast.className = 'dw-challenge-toast glass';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  toast.innerHTML = [
    '<span class="dw-challenge-medal"></span>',
    '<span class="dw-challenge-label"></span>',
    '<span class="dw-challenge-toast-time"></span>',
    '<span class="dw-challenge-toast-detail"></span>',
  ].join('');
  root.append(prompt, timer, arrow, toast);
  const parts = {
    promptName: prompt.querySelector('.dw-challenge-prompt-name'),
    promptDetail: prompt.querySelector('.dw-challenge-prompt-detail'),
    promptKey: prompt.querySelector('kbd'),
    timerLabel: timer.querySelector('.dw-challenge-timer-head .dw-challenge-label'),
    pace: timer.querySelector('.dw-challenge-pace'),
    paceText: timer.querySelector('.dw-challenge-pace span'),
    time: timer.querySelector('.dw-challenge-time'),
    gates: timer.querySelector('.dw-challenge-gates'),
    penalty: timer.querySelector('.dw-challenge-penalty'),
    split: timer.querySelector('.dw-challenge-split'),
    splitTime: timer.querySelector('.dw-challenge-split-time'),
    splitDelta: timer.querySelector('.dw-challenge-split-delta'),
    rival: timer.querySelector('.dw-challenge-rival'),
    flash: timer.querySelector('.dw-challenge-flash'),
    chevron: arrow.querySelector('.dw-challenge-chevron'),
    arrowDistance: arrow.querySelector('.dw-challenge-arrow-distance'),
    medal: toast.querySelector('.dw-challenge-medal'),
    toastLabel: toast.querySelector('.dw-challenge-label'),
    toastTime: toast.querySelector('.dw-challenge-toast-time'),
    toastDetail: toast.querySelector('.dw-challenge-toast-detail'),
  };

  // ---- The 3D gate marker -------------------------------------------------------------------------------
  const { uniform, sin, abs, smoothstep, oneMinus, uv } = TSL;
  const markerStrength = uniform(0);
  const markerColor = uniform(new THREE.Color(MEDAL_COLORS.gold));
  const markerMaterial = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
  const pulse = sin(ctx.uniforms.time.mul(4.2)).mul(0.25).add(0.75);
  markerMaterial.colorNode = markerColor.mul(1.6);
  // Both frames carry uv: u runs around (or along) the band, v across it; the band glows in its middle.
  const across = abs(uv().y.sub(0.5)).mul(2);
  markerMaterial.opacityNode = oneMinus(smoothstep(0.35, 1, across)).mul(markerStrength).mul(pulse);
  const circleGeometry = new THREE.RingGeometry(0.93, 1, 72, 1);
  remapRingUv(circleGeometry);
  const rectGeometry = buildRectFrameGeometry(0.06);
  // One mesh per frame shape (the shapes have different attributes, so a mesh never swaps its
  // geometry): the one matching the next gate shows.
  const circleMarker = createMarker(circleGeometry, 'challenge-gate-marker-circle');
  const rectMarker = createMarker(rectGeometry, 'challenge-gate-marker-rect');

  function createMarker(geometry, name) {
    const mesh = new THREE.Mesh(geometry, markerMaterial);
    mesh.name = name;
    mesh.renderOrder = 3;
    mesh.visible = false;
    mesh.frustumCulled = false;
    scene.add(mesh);
    ctx.registerPrewarm?.(mesh);
    return mesh;
  }

  /** RingGeometry's uv is planar; the glow wants v across the band: v = (r - inner) / (outer - inner). */
  function remapRingUv(geometry) {
    const position = geometry.attributes.position;
    const uvs = geometry.attributes.uv;
    for (let index = 0; index < position.count; index++) {
      const x = position.getX(index);
      const y = position.getY(index);
      const radius = Math.hypot(x, y);
      uvs.setXY(index, Math.atan2(y, x) / (Math.PI * 2) + 0.5, (radius - 0.93) / 0.07);
    }
    uvs.needsUpdate = true;
  }

  /** A unit square frame (outer edge at x, y = +-1, inner edge `band` inside it), v across the band. */
  function buildRectFrameGeometry(band) {
    const inner = 1 - band;
    const outerCorners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const positions = [];
    const uvs = [];
    const indices = [];
    for (let side = 0; side < 4; side++) {
      const [ax, ay] = outerCorners[side];
      const [bx, by] = outerCorners[(side + 1) % 4];
      const base = positions.length / 3;
      positions.push(ax, ay, 0, bx, by, 0, bx * inner, by * inner, 0, ax * inner, ay * inner, 0);
      uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    return geometry;
  }

  // ---- State ------------------------------------------------------------------------------------------------
  const shown = {
    prompt: null, timer: null, arrow: null, arrowMode: '', toast: null,
    promptKey: '', promptName: '', promptDetail: '', keyLabel: '',
    label: '', time: '', gates: '', penalty: '', pace: '', split: '', splitDelta: '', splitState: '', rival: '', flash: '',
    arrowX: NaN, arrowY: NaN, angle: NaN, distanceKey: -1,
  };
  const clocks = { timer: 0, toast: 0, flash: 0 };
  const scratch = new THREE.Vector3();
  const gateWorld = new THREE.Vector3();
  const basisRight = new THREE.Vector3();
  const basisUp = new THREE.Vector3();
  const basisNormal = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  const view = { width: window.innerWidth, height: window.innerHeight };
  window.addEventListener('resize', () => {
    view.width = window.innerWidth;
    view.height = window.innerHeight;
    shown.arrowX = NaN;
  });

  function setShown(element, key, visible) {
    if (shown[key] === visible) return;
    shown[key] = visible;
    element.dataset.state = visible ? 'shown' : 'idle';
  }

  function setText(element, key, text) {
    if (shown[key] === text) return;
    shown[key] = text;
    element.textContent = text;
  }

  /** The challengeStart key's label from the live keyboard bindings ('Y' by default). */
  function startKeyLabel() {
    const bindings = ctx.systems.input?.bindings;
    if (!bindings || typeof bindings.getRefs !== 'function') return 'Y';
    const refs = bindings.getRefs('keyboard', 'challengeStart', state.flight?.craft ?? null);
    const ref = refs.find((candidate) => candidate.type === 'key');
    return ref ? `${ref.shift ? 'Shift+' : ''}${keyLabel(ref.code)}` : '';
  }

  function craftBest(courseKey) {
    const challenges = ctx.systems.challenges;
    const craft = state.flight?.craft ?? 'glider';
    return challenges && typeof challenges.getBest === 'function' ? challenges.getBest(courseKey, craft) : null;
  }

  // ---- Prompt ---------------------------------------------------------------------------------------------
  function updatePrompt(challenge) {
    const data = challenge.active ? null : challenge.prompt;
    setShown(prompt, 'prompt', Boolean(data));
    if (!data) return;
    if (shown.promptKey !== data.courseKey) {
      shown.promptKey = data.courseKey;
      shown.keyLabel = startKeyLabel();
      parts.promptKey.textContent = shown.keyLabel;
      prompt.dataset.key = shown.keyLabel ? 'on' : 'off';
    }
    setText(parts.promptName, 'promptName', data.name);
    const best = craftBest(data.courseKey);
    const bestText = best ? ` · best ${formatChallengeTime(best.time)}${best.medal !== 'none' ? ` (${MEDAL_LABELS[best.medal].toLowerCase()})` : ''}` : '';
    setText(parts.promptDetail, 'promptDetail', `${formatDistance(data.distance)} ${compassName(data.bearing)}${bestText}`);
  }

  function compassName(degrees) {
    const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return names[Math.round((((degrees % 360) + 360) % 360) / 45) % 8];
  }

  // ---- Timer ------------------------------------------------------------------------------------------------
  function updateTimer(challenge, realDt) {
    const visible = challenge.phase === 'armed' || challenge.phase === 'running' || challenge.phase === 'finished';
    setShown(timer, 'timer', visible);
    if (!visible) return;
    timer.dataset.phase = challenge.phase;
    setText(parts.timerLabel, 'label', challenge.name ?? '');
    clocks.timer -= realDt;
    if (clocks.timer <= 0 || challenge.phase !== 'running') {
      clocks.timer = TIMER_STEP;
      setText(parts.time, 'time', challenge.phase === 'armed' ? 'Fly the start gate' : formatChallengeTime(challenge.elapsed + (challenge.phase === 'running' ? challenge.penalties : 0)));
    }
    const playable = Math.max(0, challenge.gatesTotal);
    setText(parts.gates, 'gates', playable > 0 ? `Gate ${Math.min(challenge.gateIndex + 1, playable)} / ${playable}` : '');
    setText(parts.penalty, 'penalty', challenge.missed > 0 ? `${challenge.missed} missed${challenge.penalties > 0 ? ` · +${challenge.penalties.toFixed(0)} s` : ''}` : '');
    const pace = challenge.medalPace ?? '';
    if (shown.pace !== pace) {
      shown.pace = pace;
      parts.pace.dataset.medal = pace || 'off';
      parts.paceText.textContent = pace ? `${MEDAL_LABELS[pace]} pace` : '';
    }
    const split = challenge.lastSplit;
    setText(parts.splitTime, 'split', split ? `Split ${formatChallengeTime(split.time)}` : '');
    setText(parts.splitDelta, 'splitDelta', split && split.delta !== null ? formatSplitDelta(split.delta) : '');
    const splitState = !split || split.delta === null ? 'none' : split.delta <= 0 ? 'ahead' : 'behind';
    if (shown.splitState !== splitState) {
      shown.splitState = splitState;
      parts.split.dataset.state = splitState;
    }
    const rival = challenge.rival;
    setText(parts.rival, 'rival', rival ? `${rival.name} ${rival.distanceAhead > 0 ? `${formatDistance(rival.distanceAhead)} ahead` : `${formatDistance(-rival.distanceAhead)} behind`}` : '');
  }

  function flash(kind, text) {
    clocks.flash = FLASH_SECONDS;
    parts.flash.textContent = text;
    timer.dataset.flash = kind;
    shown.flash = kind;
  }

  function updateFlash(realDt) {
    if (!shown.flash) return;
    clocks.flash -= realDt;
    if (clocks.flash > 0) return;
    shown.flash = '';
    timer.dataset.flash = '';
  }

  // ---- Arrow and 3D marker ---------------------------------------------------------------------------------
  function updateMarker(challenge) {
    const gate = challenge.active ? challenge.nextGate : null;
    if (!gate) {
      circleMarker.visible = false;
      rectMarker.visible = false;
      markerStrength.value = 0;
      return;
    }
    const isRect = gate.shape === 'rect';
    const marker = isRect ? rectMarker : circleMarker;
    (isRect ? circleMarker : rectMarker).visible = false;
    marker.visible = true;
    marker.position.set(gate.x, gate.y, gate.z);
    basisNormal.set(gate.nx, gate.ny, gate.nz);
    basisUp.set(gate.ux, gate.uy, gate.uz);
    basisRight.crossVectors(basisUp, basisNormal);
    basis.makeBasis(basisRight, basisUp, basisNormal);
    marker.quaternion.setFromRotationMatrix(basis);
    if (isRect) marker.scale.set(gate.halfWidth, gate.halfHeight, 1);
    else marker.scale.setScalar(gate.radius);
    const pace = challenge.medalPace && challenge.medalPace !== 'none' ? challenge.medalPace : 'gold';
    markerColor.value.setHex(challenge.phase === 'armed' ? MEDAL_COLORS.none : MEDAL_COLORS[pace]);
    markerStrength.value = challenge.phase === 'armed' ? 0.7 : 1;
  }

  function updateArrow(challenge) {
    const gate = challenge.active ? challenge.nextGate : null;
    const visible = Boolean(gate) && !state.photoMode;
    setShown(arrow, 'arrow', visible);
    if (!visible) return;
    gateWorld.set(gate.x, gate.y, gate.z);
    if (ctx.origin && typeof ctx.origin.toRender === 'function') ctx.origin.toRender(gateWorld, scratch);
    else scratch.copy(gateWorld);
    camera.updateMatrixWorld();
    scratch.applyMatrix4(camera.matrixWorldInverse);
    const behind = scratch.z > -0.5;
    const cameraX = scratch.x;
    const cameraY = scratch.y;
    let screenX = 0;
    let screenY = 0;
    let onScreen = false;
    if (!behind) {
      scratch.applyMatrix4(camera.projectionMatrix);
      screenX = (scratch.x * 0.5 + 0.5) * view.width;
      screenY = (-scratch.y * 0.5 + 0.5) * view.height;
      onScreen = screenX >= EDGE_MARGIN && screenX <= view.width - EDGE_MARGIN && screenY >= EDGE_MARGIN && screenY <= view.height - EDGE_MARGIN;
    }
    const distanceKey = Math.round(gate.distance / (gate.distance < 950 ? 10 : 100));
    if (distanceKey !== shown.distanceKey) {
      shown.distanceKey = distanceKey;
      parts.arrowDistance.textContent = formatDistance(gate.distance);
    }
    const mode = onScreen ? 'on' : 'edge';
    if (shown.arrowMode !== mode) {
      shown.arrowMode = mode;
      arrow.dataset.mode = mode;
    }
    if (onScreen) {
      placeArrow(screenX, screenY);
      return;
    }
    const centerX = view.width * 0.5;
    const centerY = view.height * 0.5;
    const halfX = Math.max(1, centerX - EDGE_MARGIN);
    const halfY = Math.max(1, centerY - EDGE_MARGIN);
    let directionX = behind ? cameraX : screenX - centerX;
    let directionY = behind ? -cameraY * 0.25 : screenY - centerY;
    if (behind && Math.abs(directionX) < 1e-3) directionY = halfY;
    if (Math.abs(directionX) < 1e-6 && Math.abs(directionY) < 1e-6) directionY = halfY;
    const scale = Math.min(halfX / Math.max(Math.abs(directionX), 1e-6), halfY / Math.max(Math.abs(directionY), 1e-6));
    directionX *= scale;
    directionY *= scale;
    placeArrow(centerX + directionX, centerY + directionY);
    const angle = Math.atan2(directionY, directionX);
    if (!(Math.abs(angle - shown.angle) <= 0.004)) {
      shown.angle = angle;
      parts.chevron.style.transform = `rotate(${angle.toFixed(3)}rad)`;
    }
  }

  function placeArrow(x, y) {
    if (Math.abs(x - shown.arrowX) < 0.25 && Math.abs(y - shown.arrowY) < 0.25) return;
    shown.arrowX = x;
    shown.arrowY = y;
    arrow.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
  }

  // ---- Medal toast ------------------------------------------------------------------------------------------
  function showToast(payload) {
    const medal = payload.medal;
    toast.style.setProperty('--dw-medal-color', cssColor(MEDAL_COLORS[medal] ?? MEDAL_COLORS.none));
    toast.dataset.medal = medal;
    parts.medal.textContent = medal === 'none' ? '' : MEDAL_LABELS[medal].charAt(0);
    parts.toastLabel.textContent = !payload.valid ? 'Run void · missed gates' : payload.improved ? `New best · ${MEDAL_LABELS[medal]}` : MEDAL_LABELS[medal];
    parts.toastTime.textContent = formatChallengeTime(payload.time);
    const extras = [];
    if (payload.penalties > 0) extras.push(`+${payload.penalties.toFixed(0)} s penalties`);
    if (payload.missed > 0) extras.push(`${payload.missed} missed`);
    if (Number.isFinite(payload.best) && !payload.improved) extras.push(`best ${formatChallengeTime(payload.best)}`);
    parts.toastDetail.textContent = extras.join(' · ');
    clocks.toast = TOAST_SECONDS;
    setShown(toast, 'toast', true);
  }

  function updateToast(realDt) {
    if (!shown.toast) return;
    if (state.photoMode) return;
    clocks.toast -= realDt;
    if (clocks.toast <= 0) setShown(toast, 'toast', false);
  }

  bus.onTyped('challengeGate', (payload) => {
    if (payload.missed) flash('miss', 'Missed gate');
    else if (payload.role !== 'start' && Number.isFinite(payload.delta)) flash(payload.delta <= 0 ? 'ahead' : 'behind', formatSplitDelta(payload.delta));
  });
  bus.on('challenge:sensorMiss', (payload) => flash('miss', payload && payload.penaltySeconds > 0 ? `Touched · +${payload.penaltySeconds} s` : 'Touched'));
  bus.onTyped('challengeFinished', (payload) => showToast(payload));
  bus.onTyped('challengeStarted', () => setShown(toast, 'toast', false));
  bus.onTyped('challengeCancelled', (payload) => {
    if (payload.reason === 'replaced' || payload.reason === 'removed') return;
    flash('miss', payload.reason === 'abandoned' ? 'Course abandoned' : payload.reason === 'crash' ? 'Run ended' : 'Run cancelled');
    bus.emit('notify', { text: payload.reason === 'abandoned' ? 'Challenge abandoned: too far from the next gate' : 'Challenge cancelled', kind: 'info' });
  });

  return {
    update(dt, realDt) {
      const challenge = state.challenge;
      if (!challenge) return;
      const step = Number.isFinite(realDt) ? realDt : 1 / 60;
      updatePrompt(challenge);
      updateTimer(challenge, step);
      updateFlash(step);
      updateMarker(challenge);
      updateArrow(challenge);
      updateToast(step);
    },
    /** What the HUD shows now (tests and screenshots). */
    getStats() {
      return {
        prompt: shown.prompt === true,
        promptName: shown.promptName,
        promptKey: shown.keyLabel,
        timer: shown.timer === true,
        time: shown.time,
        gates: shown.gates,
        split: shown.split,
        splitDelta: shown.splitDelta,
        splitState: shown.splitState,
        arrow: shown.arrow === true,
        arrowMode: shown.arrowMode,
        marker: circleMarker.visible || rectMarker.visible,
        toast: shown.toast === true,
        toastText: shown.toast ? `${parts.toastLabel.textContent} ${parts.toastTime.textContent}` : '',
        flash: shown.flash,
      };
    },
    dispose() {
      scene.remove(circleMarker, rectMarker);
      circleGeometry.dispose();
      rectGeometry.dispose();
      markerMaterial.dispose();
      prompt.remove();
      timer.remove();
      arrow.remove();
      toast.remove();
    },
  };
}
