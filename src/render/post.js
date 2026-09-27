import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';


// ============================================================================
// POST-PROCESSING: bloom + warm grade + vignette + grain (degrades to direct).
// ============================================================================
// Dynamic resolution scales only the scene pass (the expensive geometry render); bloom, grade
// and grain run on the full-resolution output, so the HUD-facing image stays sharp-edged and
// the canvas never resizes when the scale steps.
// Grade and vignette run in linear HDR. The pipeline's automatic colour transform is
// off: renderOutput() applies ACES + sRGB, then grain is added in display space
// (grain added before the tone curve is crushed to nothing in highlights).
// G effects (SIM, craft whose simProfile opts in with gEffects: true; driven by
// createGEffectsSystem below): gray-out, tunnel vision and red-out, in linear HDR after the
// grade, inside a uniform branch so they cost nothing while inactive.
export function createPostStack(renderer, scene, camera, uniforms) {
  const { pass, uniform, uv, vec2, vec3, vec4, float, smoothstep, mix, luminance, saturation, rand, fract, renderOutput, Fn, If } = TSL;
  const controls = {
    vignette: uniform(0.4),
    grain: uniform(0.042),
    saturation: uniform(1.06),
    warmth: uniform(1),
    exposure: uniform(1),
  };
  /** 0..1 levels of each G effect, and their maximum (the branch gate). */
  const gEffects = {
    grayout: uniform(0),
    tunnel: uniform(0),
    redout: uniform(0),
    active: uniform(0),
  };

  /**
   * Gray-out: colour drains and the view dims, closing in from the edges. Tunnel vision: black
   * outside a shrinking circle. Red-out: a dark red wash that thickens toward the edges.
   */
  const applyGEffects = Fn(([input, edge]) => {
    const color = vec3(input).toVar();
    If(gEffects.active.greaterThan(0.0005), () => {
      const luma = luminance(color);
      const grayout = gEffects.grayout;
      const closing = smoothstep(float(0.62).sub(grayout.mul(0.42)), float(0.95).sub(grayout.mul(0.3)), edge).mul(grayout);
      color.assign(mix(color, vec3(luma), grayout.mul(0.85)).mul(float(1).sub(grayout.mul(0.3))).mul(float(1).sub(closing.mul(0.92))));
      const tunnel = gEffects.tunnel;
      const radius = mix(float(0.62), float(0.1), tunnel);
      const outside = smoothstep(radius, radius.add(0.16), edge).mul(tunnel);
      color.assign(color.mul(float(1).sub(outside)).mul(float(1).sub(tunnel.mul(0.35))));
      const redout = gEffects.redout;
      const red = vec3(luma.mul(1.25).add(0.03), luma.mul(0.12), luma.mul(0.1));
      const redEdge = smoothstep(float(0.35), float(0.85), edge).mul(redout);
      color.assign(mix(color, red, redout.mul(0.7)).mul(float(1).sub(redEdge.mul(0.75))));
    });
    return color;
  });
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputColorTransform = false;
  const scenePass = pass(scene, camera);
  const sceneColor = scenePass.getTextureNode('output');
  const bloomNode = bloom(sceneColor, 0.3, 0.5, 0.9);

  function compose(hdr) {
    const luma = luminance(hdr);
    const warmTint = mix(vec3(1, 1, 1), vec3(1.05, 1.0, 0.9), controls.warmth);
    const coolShadows = mix(vec3(0.92, 0.97, 1.07), vec3(1, 1, 1), smoothstep(float(0.0), float(0.3), luma));
    let color = saturation(hdr.mul(controls.exposure), controls.saturation).mul(warmTint).mul(coolShadows);
    const edge = uv().sub(vec2(0.5, 0.5)).mul(vec2(1.0, 0.8)).length();
    color = color.mul(float(1).sub(smoothstep(float(0.3), float(0.85), edge).mul(controls.vignette)));
    color = applyGEffects(color, edge);
    const display = renderOutput(vec4(color, 1));
    const displayLuma = luminance(display.rgb);
    const midtoneWeight = displayLuma.mul(displayLuma.oneMinus()).mul(3.2).add(0.2);
    const grain = rand(uv().add(fract(uniforms.time.mul(0.713)))).sub(0.5).mul(controls.grain).mul(midtoneWeight);
    return vec4(display.rgb.add(grain), 1);
  }
  const outputWithBloom = compose(sceneColor.rgb.add(bloomNode.rgb));
  const outputWithoutBloom = compose(sceneColor.rgb);
  let bloomEnabled = true;
  pipeline.outputNode = outputWithBloom;
  return {
    pipeline,
    controls,
    gEffects,
    bloomNode,
    /** Scene render resolution relative to the canvas (0.6..1); applied from the next frame. */
    setRenderScale(scale) {
      const next = Math.min(Math.max(Number(scale) || 1, 0.25), 1);
      if (scenePass.getResolutionScale() !== next) scenePass.setResolutionScale(next);
    },
    getRenderScale() {
      return scenePass.getResolutionScale();
    },
    setBloomEnabled(enabled) {
      if (bloomEnabled === enabled) return;
      bloomEnabled = enabled;
      pipeline.outputNode = enabled ? outputWithBloom : outputWithoutBloom;
      pipeline.needsUpdate = true;
    },
  };
}


// ============================================================================
// G EFFECTS: what the pilot's eyes do under load (the 'gEffects' system).
// ============================================================================
// SIM only, for craft whose simProfile opts in (gEffects: true): gray-out from 6 g, heavy at 8 g;
// tunnel vision after 9 g held for 3 s; red-out below -2 g. Levels follow the load with the body's
// lag (quicker onset than recovery) and write the post stack's uniforms; everything reads zero, so the
// post branch is skipped, whenever the effects do not apply.
const G_EFFECTS = Object.freeze({
  GRAYOUT_FROM: 6,
  GRAYOUT_HEAVY: 8,
  GRAYOUT_FULL: 9.5,
  HEAVY_LEVEL: 0.8,
  // "9 g": the fly-by-wire holds 9 g within a tenth, so the clock runs from 8.9 g.
  TUNNEL_LOAD: 8.9,
  TUNNEL_RELEASE: 8.5,
  TUNNEL_AFTER: 3,
  TUNNEL_BUILD: 1.5,
  REDOUT_FROM: -2,
  REDOUT_FULL: -3.5,
  ONSET_SECONDS: 0.9,
  RECOVERY_SECONDS: 1.8,
  OFF_SECONDS: 0.35,
});

function smoothRange(from, to, value) {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

function follow(current, target, dt, onsetSeconds, recoverySeconds) {
  const seconds = target > current ? onsetSeconds : recoverySeconds;
  return current + (target - current) * (1 - Math.exp(-dt / seconds));
}

/** Gray-out level (0..1) for a load factor: from 6 g, heavy (0.8) at 8 g, total past 9 g. */
export function grayoutLevel(load) {
  return G_EFFECTS.HEAVY_LEVEL * smoothRange(G_EFFECTS.GRAYOUT_FROM, G_EFFECTS.GRAYOUT_HEAVY, load)
    + (1 - G_EFFECTS.HEAVY_LEVEL) * smoothRange(G_EFFECTS.GRAYOUT_HEAVY, G_EFFECTS.GRAYOUT_FULL, load);
}

export function createGEffectsSystem(ctx) {
  const { state, craftRegistry } = ctx;
  const levels = { grayout: 0, tunnel: 0, redout: 0, sustained: 0, enabled: false, load: 1 };

  function applies() {
    const flight = state.flight;
    if (flight.mode !== 'sim' || state.photoMode || (flight.crash && flight.crash.active)) return false;
    const craft = craftRegistry.get(flight.craft);
    return Boolean(craft && craft.simProfile && craft.simProfile.gEffects === true);
  }

  return {
    update(simDt, realDt) {
      const post = ctx.post;
      if (!post || !post.gEffects) return;
      const enabled = applies();
      levels.enabled = enabled;
      const load = Number.isFinite(state.flight.gLoad) ? state.flight.gLoad : 1;
      levels.load = load;
      const dt = simDt > 0 ? simDt : 0;
      if (!enabled) {
        // Off (CLASSIC, other craft, photo mode, a soft crash): clear quickly, then stay at zero.
        const fade = Math.exp(-(realDt > 0 ? realDt : 0) / G_EFFECTS.OFF_SECONDS);
        levels.grayout = levels.grayout * fade < 0.001 ? 0 : levels.grayout * fade;
        levels.tunnel = levels.tunnel * fade < 0.001 ? 0 : levels.tunnel * fade;
        levels.redout = levels.redout * fade < 0.001 ? 0 : levels.redout * fade;
        levels.sustained = 0;
      } else if (dt > 0) {
        levels.grayout = follow(levels.grayout, grayoutLevel(load), dt, G_EFFECTS.ONSET_SECONDS, G_EFFECTS.RECOVERY_SECONDS);
        // Tunnel vision: 9 g held for 3 s (the clock runs down twice as fast as it builds).
        if (load >= G_EFFECTS.TUNNEL_LOAD) levels.sustained += dt;
        else if (load < G_EFFECTS.TUNNEL_RELEASE) levels.sustained = Math.max(0, levels.sustained - 2 * dt);
        const tunnelTarget = smoothRange(G_EFFECTS.TUNNEL_AFTER, G_EFFECTS.TUNNEL_AFTER + G_EFFECTS.TUNNEL_BUILD, levels.sustained);
        levels.tunnel = follow(levels.tunnel, tunnelTarget, dt, G_EFFECTS.ONSET_SECONDS, G_EFFECTS.RECOVERY_SECONDS);
        levels.redout = follow(levels.redout, smoothRange(G_EFFECTS.REDOUT_FROM, G_EFFECTS.REDOUT_FULL, load), dt, G_EFFECTS.ONSET_SECONDS, G_EFFECTS.RECOVERY_SECONDS);
        for (const key of ['grayout', 'tunnel', 'redout']) if (levels[key] < 0.001) levels[key] = 0;
      }
      post.gEffects.grayout.value = levels.grayout;
      post.gEffects.tunnel.value = levels.tunnel;
      post.gEffects.redout.value = levels.redout;
      post.gEffects.active.value = Math.max(levels.grayout, levels.tunnel, levels.redout);
    },

    getStats() {
      return { ...levels };
    },
  };
}
