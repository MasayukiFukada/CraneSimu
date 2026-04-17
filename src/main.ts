import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

class CraneSimulator {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private world: CANNON.World;
  private controls: OrbitControls;

  // 物理体
  private prizeBody!: CANNON.Body;
  private prizeMesh!: THREE.Mesh;
  private craneBody!: CANNON.Body;
  private craneMesh!: THREE.Group;
  private leftArmBody!: CANNON.Body;
  private rightArmBody!: CANNON.Body;
  private leftArmGroup!: THREE.Group;
  private rightArmGroup!: THREE.Group;

  // 定数
  private readonly CLOSED_ANGLE = 0.1;
  private readonly OPEN_ANGLE = -0.7;
  private readonly ARM_POWER = 35.0; // 現実的なパワーに調整

  // 衝突フィルタ
  private readonly BIT_CRANE = 1;
  private readonly BIT_ARM = 2;
  private readonly BIT_PRIZE = 4;
  private readonly BIT_BRIDGE = 8;

  // 状態
  private cranePos = new THREE.Vector3(0, 6.5, 0);
  private isDropping = false;
  private isTouchingSomething = false;
  private targetLeftAngle = 0.1;
  private targetRightAngle = -0.1;

  constructor() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf0f0f0);

    const canvas = document.getElementById('canvas') as HTMLCanvasElement;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);

    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.camera.position.set(8, 8, 12);
    
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 5, 0);
    this.controls.update();

    this.world = new CANNON.World();
    this.world.gravity.set(0, -98.0, 0); // スケールに合わせた重力（1ユニット=10cm想定）
    this.world.allowSleep = false;

    this.scene.add(new THREE.GridHelper(20, 20));

    this.setupLights();
    this.setupBridge();
    this.setupPrize();
    this.setupCrane();
    this.setupUI();

    this.animate();
    window.addEventListener('resize', () => this.onWindowResize());
  }

  private setupLights() {
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dl = new THREE.DirectionalLight(0xffffff, 0.8);
    dl.position.set(5, 10, 5);
    this.scene.add(dl);
  }

  private setupBridge() {
    const bridgeMat = new CANNON.Material('bridge');
    const guardMat = new CANNON.Material('guard');
    const prizeMat = new CANNON.Material('prize');
    const armMat = new CANNON.Material('arm'); // アーム用マテリアル追加
    
    const createRod = (z: number, y: number, mat: CANNON.Material, color: number) => {
      const rodMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 10, 16), new THREE.MeshPhongMaterial({ color }));
      rodMesh.rotation.z = Math.PI / 2;
      rodMesh.position.set(0, y, z);
      this.scene.add(rodMesh);
      const body = new CANNON.Body({ mass: 0, type: CANNON.Body.STATIC, material: mat });
      body.addShape(new CANNON.Cylinder(0.1, 0.1, 10, 16), new CANNON.Vec3(0, 0, 0), new CANNON.Quaternion().setFromAxisAngle(new CANNON.Vec3(0, 0, 1), Math.PI / 2));
      body.position.set(0, y, z);
      body.collisionFilterGroup = this.BIT_BRIDGE;
      this.world.addBody(body);
    };

    createRod(-1, 3, bridgeMat, 0x888888);
    createRod(1, 3, bridgeMat, 0x888888);
    const guardZ = 1.0 + 0.4 + 0.8;
    const guardY = 3.0 + 0.5;
    createRod(-guardZ, guardY, guardMat, 0xcccccc);
    createRod(guardZ, guardY, guardMat, 0xcccccc);

    // 摩擦設定
    this.world.addContactMaterial(new CANNON.ContactMaterial(bridgeMat, prizeMat, { friction: 1.0, restitution: 0.1 }));
    this.world.addContactMaterial(new CANNON.ContactMaterial(guardMat, prizeMat, { friction: 0.1, restitution: 0.1 }));
    this.world.addContactMaterial(new CANNON.ContactMaterial(armMat, prizeMat, { friction: 0.2, restitution: 0.1 })); // アームと景品は滑りやすく
    
    (this as any).pMat = prizeMat;
    (this as any).aMat = armMat;
  }

  private setupPrize() {
    const size = { x: 1.5, y: 1, z: 2.5 };
    this.prizeMesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), new THREE.MeshPhongMaterial({ color: 0xffaa00 }));
    this.scene.add(this.prizeMesh);
    this.prizeBody = new CANNON.Body({ mass: 0.5, material: (this as any).pMat }); // 現実的な質量（500g相当）
    this.prizeBody.linearDamping = 0.05; // わずかな空気抵抗
    this.prizeBody.angularDamping = 0.1; // 回転の減衰
    this.prizeBody.addShape(new CANNON.Box(new CANNON.Vec3(size.x/2, size.y/2, size.z/2)));
    this.prizeBody.position.set(0, 4, 0);
    this.prizeBody.collisionFilterGroup = this.BIT_PRIZE;
    this.world.addBody(this.prizeBody);
  }

  private setupCrane() {
    this.craneMesh = new THREE.Group();
    this.scene.add(this.craneMesh);
    this.craneMesh.add(new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 16), new THREE.MeshPhongMaterial({ color: 0xff8c00 })));

    this.craneBody = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC });
    this.craneBody.addShape(new CANNON.Sphere(0.5));
    this.craneBody.position.set(this.cranePos.x, this.cranePos.y, this.cranePos.z);
    this.craneBody.collisionFilterGroup = this.BIT_CRANE;
    this.craneBody.collisionFilterMask = this.BIT_PRIZE | this.BIT_BRIDGE; 
    this.world.addBody(this.craneBody);

    const createArm = (isLeft: boolean) => {
      const group = new THREE.Group();
      const mat = new THREE.MeshPhongMaterial({ color: 0x6666ff });
      const ur = isLeft ? -1.0 : 1.0, lr = isLeft ? 0.6 : -0.6, tr = isLeft ? -0.1 : 0.1;

      const upper = new THREE.Mesh(new THREE.BoxGeometry(0.225, 1.3, 0.2), new THREE.MeshPhongMaterial({ color: 0x00ffff }));
      upper.rotation.z = ur;
      upper.position.set(Math.sin(ur)*0.5, -Math.cos(ur)*0.5, 0);
      group.add(upper);

      const lower = new THREE.Mesh(new THREE.BoxGeometry(0.075, 1.8, 0.2), new THREE.MeshPhongMaterial({ color: 0xff00ff }));
      lower.rotation.z = lr;
      const p1x = Math.sin(ur)*1.2, p1y = -Math.cos(ur)*1.2;
      lower.position.set(p1x + Math.sin(lr)*0.6, p1y - Math.cos(lr)*0.6, 0);
      group.add(lower);

      const tip = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.05, 0.2), new THREE.MeshPhongMaterial({ color: 0x00ff00 }));
      tip.rotation.z = tr;
      const p2x = p1x + Math.sin(lr)*1.2, p2y = p1y - Math.cos(lr)*1.2;
      tip.position.set(p2x + (isLeft?0.1:-0.1), p2y, 0);
      group.add(tip);
      this.scene.add(group);

      const body = new CANNON.Body({ mass: 0.5, material: (this as any).aMat });
      body.addShape(new CANNON.Box(new CANNON.Vec3(0.11, 0.5, 0.1)), new CANNON.Vec3(upper.position.x, upper.position.y, 0), new CANNON.Quaternion().setFromAxisAngle(new CANNON.Vec3(0,0,1), ur));
      body.addShape(new CANNON.Box(new CANNON.Vec3(0.04, 0.6, 0.1)), new CANNON.Vec3(lower.position.x, lower.position.y, 0), new CANNON.Quaternion().setFromAxisAngle(new CANNON.Vec3(0,0,1), lr));
      body.addShape(new CANNON.Box(new CANNON.Vec3(0.1, 0.02, 0.1)), new CANNON.Vec3(tip.position.x, tip.position.y, 0), new CANNON.Quaternion().setFromAxisAngle(new CANNON.Vec3(0,0,1), tr));

      const attach = isLeft ? new CANNON.Vec3(-0.5, -0.2, 0) : new CANNON.Vec3(0.5, -0.2, 0);
      body.position.set(this.cranePos.x + attach.x, this.cranePos.y + attach.y, this.cranePos.z);
      body.angularDamping = 0.8;
      body.collisionFilterGroup = this.BIT_ARM;
      body.collisionFilterMask = this.BIT_PRIZE | this.BIT_BRIDGE; 
      this.world.addBody(body);

      this.world.addConstraint(new CANNON.PointToPointConstraint(this.craneBody, attach, body, new CANNON.Vec3(0,0,0)));
      return { group, body };
    };

    const left = createArm(true);
    this.leftArmGroup = left.group; this.leftArmBody = left.body;
    const right = createArm(false);
    this.rightArmGroup = right.group; this.rightArmBody = right.body;

    const onCollide = (e: any) => { if (e.body === this.prizeBody) this.isTouchingSomething = true; };
    this.craneBody.addEventListener('collide', onCollide);
    this.leftArmBody.addEventListener('collide', onCollide);
    this.rightArmBody.addEventListener('collide', onCollide);
  }

  private setupUI() {
    const buttons = { 'btn-left': { x: -1, z: 0 }, 'btn-right': { x: 1, z: 0 }, 'btn-forward': { x: 0, z: -1 }, 'btn-backward': { x: 0, z: 1 } };
    const activeKeys = new Set<string>();
    Object.entries(buttons).forEach(([id, dir]) => {
      const btn = document.getElementById(id);
      if (btn) {
        btn.addEventListener('mousedown', () => activeKeys.add(id));
        ['mouseup', 'mouseleave'].forEach(evt => btn.addEventListener(evt, () => activeKeys.delete(id)));
        btn.addEventListener('touchstart', (e) => { e.preventDefault(); activeKeys.add(id); });
        btn.addEventListener('touchend', () => activeKeys.delete(id));
      }
    });

    document.getElementById('btn-drop')?.addEventListener('click', () => this.startDropSequence());
    document.getElementById('btn-reset')?.addEventListener('click', () => this.resetPosition());
    document.getElementById('btn-open')?.addEventListener('click', () => { this.targetLeftAngle = this.OPEN_ANGLE; this.targetRightAngle = -this.OPEN_ANGLE; });
    document.getElementById('btn-close')?.addEventListener('click', () => { this.targetLeftAngle = this.CLOSED_ANGLE; this.targetRightAngle = -this.CLOSED_ANGLE; });

    this.world.addEventListener('preStep', () => {
      this.applyArmTorque();
      if (!this.isDropping) {
        activeKeys.forEach(id => {
          const dir = (buttons as any)[id];
          if (dir) { this.cranePos.x += dir.x * 0.05; this.cranePos.z += dir.z * 0.05; }
        });
        this.craneBody.position.set(this.cranePos.x, this.cranePos.y, this.cranePos.z);
      }
    });
  }

  private applyArmTorque() {
    const control = (body: CANNON.Body, target: number) => {
      const q = body.quaternion;
      const current = 2 * Math.atan2(q.z, q.w);
      const diff = target - current;
      const torque = diff * this.ARM_POWER - body.angularVelocity.z * 1.5;
      body.torque.z = torque;
      body.angularVelocity.x *= 0.9; body.angularVelocity.y *= 0.9;
      body.quaternion.x = 0; body.quaternion.y = 0; body.quaternion.normalize();
      return current;
    };
    control(this.leftArmBody, this.targetLeftAngle);
    control(this.rightArmBody, this.targetRightAngle);
  }

  private async startDropSequence() {
    if (this.isDropping) return;
    this.isDropping = true;
    this.isTouchingSomething = false;
    this.targetLeftAngle = this.OPEN_ANGLE; this.targetRightAngle = -this.OPEN_ANGLE;
    await new Promise(r => setTimeout(r, 1500));

    const startY = this.cranePos.y;
    while (this.cranePos.y > 3.2 && !this.isTouchingSomething) {
      this.cranePos.y -= 0.0125;
      this.craneBody.position.y = this.cranePos.y;
      await new Promise(r => setTimeout(r, 16));
    }

    this.targetLeftAngle = this.CLOSED_ANGLE; this.targetRightAngle = -this.CLOSED_ANGLE;
    await new Promise(r => setTimeout(r, 2000));

    while (this.cranePos.y < startY) {
      this.cranePos.y += 0.0125;
      this.craneBody.position.y = this.cranePos.y;
      await new Promise(r => setTimeout(r, 16));
    }
    this.isDropping = false;
    this.isTouchingSomething = false;
  }

  private resetPosition() {
    this.prizeBody.position.set(0, 4, 0);
    this.prizeBody.velocity.set(0, 0, 0);
    this.prizeBody.angularVelocity.set(0, 0, 0);
    this.prizeBody.quaternion.set(0, 0, 0, 1);
    this.cranePos.set(0, 8.5, 0);
    this.craneBody.position.set(0, 8.5, 0);
    this.isTouchingSomething = false;
    this.targetLeftAngle = 0.1;
    this.targetRightAngle = -0.1;
    [this.leftArmBody, this.rightArmBody].forEach((body, i) => {
      const attach = i === 0 ? new CANNON.Vec3(-0.5, -0.2, 0) : new CANNON.Vec3(0.5, -0.2, 0);
      body.position.set(this.cranePos.x + attach.x, this.cranePos.y + attach.y, this.cranePos.z);
      body.quaternion.set(0, 0, 0, 1);
      body.velocity.set(0, 0, 0);
      body.angularVelocity.set(0, 0, 0);
    });
  }

  private onWindowResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  private animate() {
    requestAnimationFrame(() => this.animate());
    this.world.fixedStep();
    if (this.prizeMesh) { this.prizeMesh.position.copy(this.prizeBody.position as any); this.prizeMesh.quaternion.copy(this.prizeBody.quaternion as any); }
    if (this.craneMesh) { this.craneMesh.position.copy(this.craneBody.position as any); this.craneMesh.quaternion.copy(this.craneBody.quaternion as any); }
    if (this.leftArmGroup) { this.leftArmGroup.position.copy(this.leftArmBody.position as any); this.leftArmGroup.quaternion.copy(this.leftArmBody.quaternion as any); }
    if (this.rightArmGroup) { this.rightArmGroup.position.copy(this.rightArmBody.position as any); this.rightArmGroup.quaternion.copy(this.rightArmBody.quaternion as any); }
    this.renderer.render(this.scene, this.camera);
  }
}
new CraneSimulator();
