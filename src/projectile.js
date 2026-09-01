import * as THREE from "three";

// A projectile launched at a fixed target point, following a simple arc.
// On arrival, calls onImpact(attacker, targetUnit, damage) if the target is
// still alive — main.js's onImpact handles applying damage, the floating
// damage number (shown above the attacker), and death-fade, all in one place.
export class Projectile {
  constructor(scene, fromPos, toPos, damage, attacker, targetUnit, onImpact, options = {}) {
    this.scene = scene;
    this.attacker = attacker;
    this.targetUnit = targetUnit;
    this.damage = damage;
    this.onImpact = onImpact;
    this.from = fromPos.clone();
    this.to = toPos.clone();
    this.arcHeight = options.arcHeight ?? 1.2;
    this.duration = Math.max(0.15, this.from.distanceTo(this.to) / (options.speed ?? 16));
    this.elapsed = 0;
    this.done = false;

    const geometry = new THREE.SphereGeometry(options.radius ?? 0.16, 8, 8);
    const material = new THREE.MeshBasicMaterial({ color: options.color ?? 0xffe066 });
    this.mesh = new THREE.Mesh(geometry, material);
    scene.add(this.mesh);
    this._setPositionAt(0);
  }

  _setPositionAt(t) {
    const pos = new THREE.Vector3().lerpVectors(this.from, this.to, t);
    pos.y += Math.sin(t * Math.PI) * this.arcHeight;
    this.mesh.position.copy(pos);
  }

  update(delta) {
    if (this.done) return;
    this.elapsed += delta;
    const t = Math.min(1, this.elapsed / this.duration);
    this._setPositionAt(t);

    if (t >= 1) {
      this.done = true;
      this.scene.remove(this.mesh);
      if (this.targetUnit.alive) {
        this.onImpact(this.attacker, this.targetUnit, this.damage);
      }
    }
  }
}
