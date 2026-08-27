import * as THREE from 'three';
import type { GameState } from '../sim/GameState';

/** FROZEN. Renderer/scene/camera singletons. Render modules import R and add their objects
 *  to R.scene. The camera is driven by the player controller. */
export const R = {} as {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
};

export function initScene(_game: GameState): void {
  R.scene = new THREE.Scene();
  R.scene.background = new THREE.Color(0x8db8d8);
  R.scene.fog = new THREE.Fog(0x8db8d8, 90, 220);

  R.camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 500);
  R.camera.position.set(0, 8, 30);
  R.camera.lookAt(0, 2, -40);

  R.renderer = new THREE.WebGLRenderer({ antialias: true });
  R.renderer.setSize(innerWidth, innerHeight);
  R.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  R.renderer.shadowMap.enabled = true;
  R.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.getElementById('app')!.appendChild(R.renderer.domElement);

  addEventListener('resize', () => {
    R.camera.aspect = innerWidth / innerHeight;
    R.camera.updateProjectionMatrix();
    R.renderer.setSize(innerWidth, innerHeight);
  });
}
