import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

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

  // デバッグ用フラグ (物理コライダーの表示)
  private readonly DEBUG_SHOW_COLLIDERS = true;

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

  constructor(bodyGeometry: THREE.BufferGeometry, armGeometry: THREE.BufferGeometry) {
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
    this.setupCrane(bodyGeometry, armGeometry);
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

  private setupCrane(bodyGeom: THREE.BufferGeometry, armGeom: THREE.BufferGeometry) {
    // クレーン本体 of 3Dモデル調整
    const bodyGeometry = bodyGeom.clone();
    bodyGeometry.center(); // 原点を中心に合わせる
    bodyGeometry.rotateX(-Math.PI / 2); // 元の回転: Z-up から Y-up に変換
    bodyGeometry.translate(0, 5.0, 0); // アーム上端（回転軸）に合わせて本体を上方にオフセット
    bodyGeometry.scale(0.1, 0.1, 0.1); // スケーリング

    this.craneMesh = new THREE.Group();
    this.scene.add(this.craneMesh);
    
    // クレーン本体のメッシュ作成
    const bodyMat = new THREE.MeshPhongMaterial({ color: 0xff8c00, side: THREE.DoubleSide });
    const bodyMesh = new THREE.Mesh(bodyGeometry, bodyMat);
    this.craneMesh.add(bodyMesh);

    // KINEMATICボディ（衝突判定用、元のSphereコライダーを維持）
    this.craneBody = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC });
    this.craneBody.addShape(new CANNON.Sphere(0.5));
    this.craneBody.position.set(this.cranePos.x, this.cranePos.y, this.cranePos.z);
    this.craneBody.collisionFilterGroup = this.BIT_CRANE;
    this.craneBody.collisionFilterMask = this.BIT_PRIZE | this.BIT_BRIDGE; 
    this.world.addBody(this.craneBody);

    const createArm = (isLeft: boolean) => {
      const group = new THREE.Group();
      
      // アームの3Dモデル調整
      const armGeometry = armGeom.clone();
      armGeometry.rotateX(-Math.PI / 2); // 元の回転: Z-up から Y-up に変換 (爪が下、ヒンジが上)

      // 上端（ヒンジ）を原点(0,0,0)に合わせるための平行移動
      armGeometry.computeBoundingBox();
      if (armGeometry.boundingBox) {
        const maxY = armGeometry.boundingBox.max.y;
        armGeometry.translate(0, -maxY, 0);
      }

      // アームメッシュの作成
      const armMat = new THREE.MeshPhongMaterial({ 
        color: 0x6666ff, 
        side: THREE.DoubleSide,
        flatShading: true
      });
      const armMesh = new THREE.Mesh(armGeometry, armMat);
      
      // 微調整用オフセット (左右個別に設定)
      // 左アームは右方向（正の値）、右アームは左方向（負の値）へシフトすることで内側に移動します
      const offsetX = isLeft ? 0.25 : -0.3; // 左アームを少し右（内側）へ、右アームを左（内側）へシフト
      const offsetY = 0.2;
      armMesh.position.set(offsetX, offsetY, 0);
      
      // スケール適用。右アームはX軸を反転させて鏡写しにする
      armMesh.scale.set(isLeft ? 0.1 : -0.1, 0.1, 0.1);
      group.add(armMesh);
      
      // 物理コライダーの寸法・角度パラメータ（STLモデルに合わせて調整可能）
      const ur = isLeft ? -1.0 : 1.0;   // 上アームの傾き（ラジアン）- そのまま維持
      const lr = isLeft ? 0.48 : -0.48; // 下アームの傾き（ラジアン）- 傾きを緩めて外側を通す
      const tr = isLeft ? -0.05 : 0.05; // 爪先の傾き（ラジアン）- ほぼ水平
      
      const L1 = 1.05; // 上アームの長さ
      const L2 = 1.35; // 下アームの長さ - やや長かったため少し短縮
      
      const W1 = 0.15; // 上アームの半幅
      const W2 = 0.09; // 下アームの半幅
      const W3 = 0.02; // 爪先の半厚み - 少し厚かったため薄く調整（厚さ 0.04）
      const H3 = 0.12; // 爪先の半長さ (全幅 0.24)
      
      // 各関節の接続点計算
      const p1x = Math.sin(ur) * L1;
      const p1y = -Math.cos(ur) * L1;
      const p2x = p1x + Math.sin(lr) * L2;
      const p2y = p1y - Math.cos(lr) * L2;
      
      // コライダーの中心位置計算
      const c1 = new THREE.Vector3(p1x * 0.5, p1y * 0.5, 0); // 上アーム中心
      const c2 = new THREE.Vector3(p1x + Math.sin(lr) * L2 * 0.5, p1y - Math.cos(lr) * L2 * 0.5, 0); // 下アーム中心
      const c3 = new THREE.Vector3(p2x + (isLeft ? 1 : -1) * Math.cos(tr) * H3, p2y + Math.sin(tr) * H3, 0); // 爪先中心
      
      // デバッグ用に物理コライダーを可視化する場合
      if (this.DEBUG_SHOW_COLLIDERS) {
        const debugMatUpper = new THREE.MeshBasicMaterial({ color: 0x00ffff, wireframe: true, transparent: true, opacity: 0.5 });
        const upper = new THREE.Mesh(new THREE.BoxGeometry(W1 * 2, L1, 0.2), debugMatUpper);
        upper.rotation.z = ur;
        upper.position.copy(c1);
        group.add(upper);

        const debugMatLower = new THREE.MeshBasicMaterial({ color: 0xff00ff, wireframe: true, transparent: true, opacity: 0.5 });
        const lower = new THREE.Mesh(new THREE.BoxGeometry(W2 * 2, L2, 0.2), debugMatLower);
        lower.rotation.z = lr;
        lower.position.copy(c2);
        group.add(lower);

        const debugMatTip = new THREE.MeshBasicMaterial({ color: 0x00ff00, wireframe: true, transparent: true, opacity: 0.5 });
        const tip = new THREE.Mesh(new THREE.BoxGeometry(H3 * 2, W3 * 2, 0.2), debugMatTip);
        tip.rotation.z = tr;
        tip.position.copy(c3);
        group.add(tip);
      }
      
      this.scene.add(group);

      const body = new CANNON.Body({ mass: 0.5, material: (this as any).aMat });
      body.addShape(new CANNON.Box(new CANNON.Vec3(W1, L1 * 0.5, 0.1)), new CANNON.Vec3(c1.x, c1.y, 0), new CANNON.Quaternion().setFromAxisAngle(new CANNON.Vec3(0,0,1), ur));
      body.addShape(new CANNON.Box(new CANNON.Vec3(W2, L2 * 0.5, 0.1)), new CANNON.Vec3(c2.x, c2.y, 0), new CANNON.Quaternion().setFromAxisAngle(new CANNON.Vec3(0,0,1), lr));
      body.addShape(new CANNON.Box(new CANNON.Vec3(H3, W3, 0.1)), new CANNON.Vec3(c3.x, c3.y, 0), new CANNON.Quaternion().setFromAxisAngle(new CANNON.Vec3(0,0,1), tr));

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
    Object.keys(buttons).forEach(id => {
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

  static async init() {
    const loader = new STLLoader();
    try {
      const [bodyGeom, armGeom] = await Promise.all([
        loader.loadAsync('/crane_body.stl'),
        loader.loadAsync('/crane_arm.stl')
      ]);
      return new CraneSimulator(bodyGeom, armGeom);
    } catch (err) {
      console.error('Failed to load STL assets, falling back to basic geometries', err);
      const bodyGeom = new THREE.SphereGeometry(0.5, 16, 16);
      const armGeom = new THREE.BoxGeometry(0.2, 2.0, 0.2); // ダミー
      return new CraneSimulator(bodyGeom, armGeom);
    }
  }
}
CraneSimulator.init();
