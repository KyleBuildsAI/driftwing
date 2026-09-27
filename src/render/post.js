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
export function createPostStack(renderer, scene, camera, uniforms) {
  const { pass, uniform, uv, vec2, vec3, vec4, float, smoothstep, mix, luminance, saturation, rand, fract, renderOutput } = TSL;
  const controls = {
    vignette: uniform(0.4),
    grain: uniform(0.042),
    saturation: uniform(1.06),
    warmth: uniform(1),
    exposure: uniform(1),
  };
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
