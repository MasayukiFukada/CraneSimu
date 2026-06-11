import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

class CraneSimulator {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private world!: RAPIER.World;
  private eventQueue!: RAPIER.EventQueue;
  private controls: OrbitControls;

  // 物理体
  private prizeBody!: RAPIER.RigidBody;
  private prizeMesh!: THREE.Mesh;
  private craneBody!: RAPIER.RigidBody;
  private craneMesh!: THREE.Group;
  private leftArmBody!: RAPIER.RigidBody;
  private rightArmBody!: RAPIER.RigidBody;
  private leftArmGroup!: THREE.Group;
  private rightArmGroup!: THREE.Group;
  private leftJoint!: RAPIER.RevoluteImpulseJoint;
  private rightJoint!: RAPIER.RevoluteImpulseJoint;

  // デバッグ用フラグ (物理コライダーの表示)
  private readonly DEBUG_SHOW_COLLIDERS = true;

  // 定数
  private readonly CLOSED_ANGLE = 0.1;
  private readonly OPEN_ANGLE = -Math.PI * 70 / 180; // 70度まで開くように調整（90度から20度減）

  // 衝突フィルタ (RapierのcollisionGroups用ビット)
  private readonly BIT_CRANE = 1;
  private readonly BIT_ARM = 2;
  private readonly BIT_PRIZE = 4;
  private readonly BIT_BRIDGE = 8;

  // 状態
  private cranePos = new THREE.Vector3(0, 6.5, 0);
  private readonly prizeStartPos = new THREE.Vector3(0, 4.0, -0.3); // 箱の初期位置 (Z方向に-0.3オフセットして奥側に配置)
  private isDropping = false;
  private isTouchingSomething = false;
  private targetLeftAngle = 0.1;
  private targetRightAngle = -0.1;
  private currentLeftAngle = 0.1;
  private currentRightAngle = -0.1;

  // 操作キーとボタン
  private activeKeys = new Set<string>();
  private readonly buttons = {
    'btn-left': { x: -1, z: 0 },
    'btn-right': { x: 1, z: 0 },
    'btn-forward': { x: 0, z: -1 },
    'btn-backward': { x: 0, z: 1 }
  };

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

    // Rapier World初期化 (重力設定)
    this.world = new RAPIER.World({ x: 0.0, y: -98.0, z: 0.0 });
    this.eventQueue = new RAPIER.EventQueue(true);

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
    // 摩擦係数を乗算(Multiply)で合成することで、Cannon-esの挙動を正確に再現する
    const createRod = (z: number, y: number, friction: number, restitution: number, color: number) => {
      const rodMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 10, 16), new THREE.MeshPhongMaterial({ color }));
      rodMesh.rotation.z = Math.PI / 2;
      rodMesh.position.set(0, y, z);
      this.scene.add(rodMesh);

      // STATICボディの作成
      const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(0, y, z);
      const body = this.world.createRigidBody(bodyDesc);

      // コライダーの作成とアタッチ (シリンダーの向き調整)
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
      const colliderDesc = RAPIER.ColliderDesc.cylinder(5.0, 0.1) // height 10 => halfHeight 5.0
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setFriction(friction)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply)
        .setRestitution(restitution)
        .setCollisionGroups((this.BIT_BRIDGE << 16) | (this.BIT_CRANE | this.BIT_ARM | this.BIT_PRIZE));
      
      this.world.createCollider(colliderDesc, body);
    };

    // 橋の棒 (摩擦: 10.0 - 滑り止めを非常に強力にし、アームで引っ張られたときに向きが変わりやすくする)
    // 箱の横幅 1.5 よりも少し広い程度（間隔 1.7）に調整
    createRod(-0.85, 3, 10.0, 0.1, 0x888888);
    createRod(0.85, 3, 10.0, 0.1, 0x888888);

    // 落下防止のガード (摩擦: 0.1)
    // 隙間を0.9に調整し、箱の向きが変わる余地を残しつつ落下しすぎないようにする
    const guardZ = 0.85 + 0.9;
    const guardY = 3.0 + 0.5;
    createRod(-guardZ, guardY, 0.1, 0.1, 0xcccccc);
    createRod(guardZ, guardY, 0.1, 0.1, 0xcccccc);
  }

  private setupPrize() {
    const size = { x: 1.5, y: 1, z: 2.5 };
    this.prizeMesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), new THREE.MeshPhongMaterial({ color: 0xffaa00 }));
    this.scene.add(this.prizeMesh);

    // 景品の物理ボディ (DYNAMIC)
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(this.prizeStartPos.x, this.prizeStartPos.y, this.prizeStartPos.z)
      .setLinearDamping(0.05)
      .setAngularDamping(0.1)
      .setCanSleep(false);
    this.prizeBody = this.world.createRigidBody(bodyDesc);

    // コライダーの作成 (質量 500g 相当)
    const colliderDesc = RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2)
      .setMass(0.5)
      .setFriction(1.0)
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply)
      .setRestitution(0.1)
      .setCollisionGroups((this.BIT_PRIZE << 16) | (this.BIT_CRANE | this.BIT_ARM | this.BIT_BRIDGE))
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS); // 衝突判定イベントを受け取る

    this.world.createCollider(colliderDesc, this.prizeBody);
  }

  private setupCrane(bodyGeom: THREE.BufferGeometry, armGeom: THREE.BufferGeometry) {
    // クレーン本体 of 3Dモデル調整 (Three.js側)
    const bodyGeometry = bodyGeom.clone();
    bodyGeometry.center();
    bodyGeometry.rotateX(-Math.PI / 2);
    bodyGeometry.translate(0, 5.0, 0);
    bodyGeometry.scale(0.1, 0.1, 0.1);

    this.craneMesh = new THREE.Group();
    this.scene.add(this.craneMesh);
    
    const bodyMat = new THREE.MeshPhongMaterial({ color: 0xff8c00, side: THREE.DoubleSide });
    const bodyMesh = new THREE.Mesh(bodyGeometry, bodyMat);
    this.craneMesh.add(bodyMesh);

    // 位置ベースの KINEMATIC ボディ (位置をスクリプトから制御)
    const craneBodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(this.cranePos.x, this.cranePos.y, this.cranePos.z);
    this.craneBody = this.world.createRigidBody(craneBodyDesc);

    // 球コライダー
    const craneColliderDesc = RAPIER.ColliderDesc.ball(0.5)
      .setCollisionGroups((this.BIT_CRANE << 16) | (this.BIT_PRIZE | this.BIT_BRIDGE))
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    this.world.createCollider(craneColliderDesc, this.craneBody);

    const createArm = (isLeft: boolean) => {
      const group = new THREE.Group();
      
      // アームの3Dモデル調整
      const armGeometry = armGeom.clone();
      armGeometry.rotateX(-Math.PI / 2);

      armGeometry.computeBoundingBox();
      if (armGeometry.boundingBox) {
        const maxY = armGeometry.boundingBox.max.y;
        armGeometry.translate(0, -maxY, 0);
      }

      const armMat = new THREE.MeshPhongMaterial({ 
        color: 0x6666ff, 
        side: THREE.DoubleSide,
        flatShading: true
      });
      const armMesh = new THREE.Mesh(armGeometry, armMat);
      
      const offsetX = isLeft ? 0.25 : -0.3;
      const offsetY = 0.2;
      armMesh.position.set(offsetX, offsetY, 0);
      
      armMesh.scale.set(isLeft ? 0.1 : -0.1, 0.1, 0.1);
      group.add(armMesh);
      
      // 物理コライダーの寸法・角度パラメータ
      const ur = isLeft ? -1.0 : 1.0;
      const lr = isLeft ? 0.48 : -0.48;
      const tr = isLeft ? -0.05 : 0.05;
      
      const L1 = 1.05;
      const L2 = 1.35;
      
      const W1 = 0.15;
      const W2 = 0.09;
      const W3 = 0.02;
      const H3 = 0.12;
      
      const p1x = Math.sin(ur) * L1;
      const p1y = -Math.cos(ur) * L1;
      const p2x = p1x + Math.sin(lr) * L2;
      const p2y = p1y - Math.cos(lr) * L2;
      
      const c1 = new THREE.Vector3(p1x * 0.5, p1y * 0.5, 0);
      const c2 = new THREE.Vector3(p1x + Math.sin(lr) * L2 * 0.5, p1y - Math.cos(lr) * L2 * 0.5, 0);
      const c3 = new THREE.Vector3(p2x + (isLeft ? 1 : -1) * Math.cos(tr) * H3, p2y + Math.sin(tr) * H3, 0);
      
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

      const attach = isLeft ? new THREE.Vector3(-0.5, -0.2, 0) : new THREE.Vector3(0.5, -0.2, 0);
      
      // アームの物理ボディ (DYNAMIC)
      const armBodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(this.cranePos.x + attach.x, this.cranePos.y + attach.y, this.cranePos.z)
        .setAngularDamping(0.8)
        .setCanSleep(false);
      const body = this.world.createRigidBody(armBodyDesc);

      // 複合コライダーの設定 (上アーム、下アーム、爪先)
      const addCollider = (width: number, height: number, depth: number, offset: THREE.Vector3, rotZ: number) => {
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rotZ);
        const colDesc = RAPIER.ColliderDesc.cuboid(width, height, depth)
          .setTranslation(offset.x, offset.y, offset.z)
          .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
          .setFriction(0.2) // アームと景品は滑りやすく
          .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply)
          .setRestitution(0.1)
          .setCollisionGroups((this.BIT_ARM << 16) | (this.BIT_PRIZE | this.BIT_BRIDGE))
          .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
          .setMass(0.5 / 3.0); // 3つ足して0.5になるように質量を分割
        this.world.createCollider(colDesc, body);
      };

      addCollider(W1, L1 * 0.5, 0.1, c1, ur);
      addCollider(W2, L2 * 0.5, 0.1, c2, lr);
      addCollider(H3, W3, 0.1, c3, tr);

      // クレーン本体とアームを RevoluteJoint (回転ジョイント) で結合
      // これにより、アームはクレーン本体に対してZ軸中心にしか回転しなくなる
      const jointData = RAPIER.JointData.revolute(
        { x: attach.x, y: attach.y, z: attach.z }, // クレーン本体基準アンカー
        { x: 0.0, y: 0.0, z: 0.0 },                 // アーム基準アンカー
        { x: 0.0, y: 0.0, z: 1.0 }                  // Z軸を中心に回転
      );
      const joint = this.world.createImpulseJoint(jointData, this.craneBody, body, true) as RAPIER.RevoluteImpulseJoint;

      // 初期状態のモーター設定 (stiffness: 600.0, damping: 15.0 で90度持ち上げる強力な力を確保)
      joint.configureMotorPosition(isLeft ? 0.1 : -0.1, 600.0, 15.0);

      return { group, body, joint };
    };

    const left = createArm(true);
    this.leftArmGroup = left.group; this.leftArmBody = left.body; this.leftJoint = left.joint;
    const right = createArm(false);
    this.rightArmGroup = right.group; this.rightArmBody = right.body; this.rightJoint = right.joint;
  }

  private setupUI() {
    Object.keys(this.buttons).forEach(id => {
      const btn = document.getElementById(id);
      if (btn) {
        btn.addEventListener('mousedown', () => this.activeKeys.add(id));
        ['mouseup', 'mouseleave'].forEach(evt => btn.addEventListener(evt, () => this.activeKeys.delete(id)));
        btn.addEventListener('touchstart', (e) => { e.preventDefault(); this.activeKeys.add(id); });
        btn.addEventListener('touchend', () => this.activeKeys.delete(id));
      }
    });

    // キーボード操作のサポート
    window.addEventListener('keydown', (e) => {
      if (this.isDropping) return;
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') this.activeKeys.add('btn-left');
      if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') this.activeKeys.add('btn-right');
      if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') this.activeKeys.add('btn-forward');
      if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') this.activeKeys.add('btn-backward');
      
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        this.startDropSequence();
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') this.activeKeys.delete('btn-left');
      if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') this.activeKeys.delete('btn-right');
      if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') this.activeKeys.delete('btn-forward');
      if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') this.activeKeys.delete('btn-backward');
    });

    document.getElementById('btn-drop')?.addEventListener('click', () => this.startDropSequence());
    document.getElementById('btn-reset')?.addEventListener('click', () => this.resetPosition());
    document.getElementById('btn-open')?.addEventListener('click', () => { this.targetLeftAngle = this.OPEN_ANGLE; this.targetRightAngle = -this.OPEN_ANGLE; });
    document.getElementById('btn-close')?.addEventListener('click', () => { this.targetLeftAngle = this.CLOSED_ANGLE; this.targetRightAngle = -this.CLOSED_ANGLE; });
  }

  private applyArmTorque() {
    const angleSpeed = 0.007; // 1ステップあたりの回転角
    
    // 左アームの現在ターゲット更新
    if (this.currentLeftAngle < this.targetLeftAngle) {
      this.currentLeftAngle = Math.min(this.targetLeftAngle, this.currentLeftAngle + angleSpeed);
    } else if (this.currentLeftAngle > this.targetLeftAngle) {
      this.currentLeftAngle = Math.max(this.targetLeftAngle, this.currentLeftAngle - angleSpeed);
    }

    // 右アームの現在ターゲット更新
    if (this.currentRightAngle < this.targetRightAngle) {
      this.currentRightAngle = Math.min(this.targetRightAngle, this.currentRightAngle + angleSpeed);
    } else if (this.currentRightAngle > this.targetRightAngle) {
      this.currentRightAngle = Math.max(this.targetRightAngle, this.currentRightAngle - angleSpeed);
    }

    // 実際の角度を取得するヘルパー (二重被覆などを防ぐため [-PI, PI] に正規化)
    const getActualAngle = (body: RAPIER.RigidBody) => {
      const q = body.rotation();
      const angle = 2 * Math.atan2(q.z, q.w);
      return Math.atan2(Math.sin(angle), Math.cos(angle));
    };
    const actualLeft = getActualAngle(this.leftArmBody);
    const actualRight = getActualAngle(this.rightArmBody);

    // 外力によって押し広げられたときに閉じる挙動をストップするロジック
    const tolerance = 0.03;
    if (this.targetLeftAngle === this.CLOSED_ANGLE && Math.abs(this.currentLeftAngle - this.targetLeftAngle) < 0.001) {
      if (actualLeft < this.currentLeftAngle - tolerance) {
        this.targetLeftAngle = actualLeft;
        this.currentLeftAngle = actualLeft;
      }
    }
    if (this.targetRightAngle === -this.CLOSED_ANGLE && Math.abs(this.currentRightAngle - this.targetRightAngle) < 0.001) {
      if (actualRight > this.currentRightAngle + tolerance) {
        this.targetRightAngle = actualRight;
        this.currentRightAngle = actualRight;
      }
    }

    // ジョイントの位置モーターを直接制御 (90度持ち上げられる強力な力を設定)
    const stiffness = 600.0;
    const damping = 15.0;
    this.leftJoint.configureMotorPosition(this.currentLeftAngle, stiffness, damping);
    this.rightJoint.configureMotorPosition(this.currentRightAngle, stiffness, damping);
  }

  private async startDropSequence() {
    if (this.isDropping) return;
    this.isDropping = true;
    this.isTouchingSomething = false;
    this.targetLeftAngle = this.OPEN_ANGLE; this.targetRightAngle = -this.OPEN_ANGLE;
    await new Promise(r => setTimeout(r, 1800));

    const startY = this.cranePos.y;
    while (this.cranePos.y > 3.2 && !this.isTouchingSomething) {
      this.cranePos.y -= 0.0125;
      this.craneBody.setNextKinematicTranslation({ x: this.cranePos.x, y: this.cranePos.y, z: this.cranePos.z });
      await new Promise(r => setTimeout(r, 16));
    }

    if (this.isTouchingSomething) {
      const pushDistance = 0.12;
      const pushSteps = Math.floor(pushDistance / 0.0125);
      for (let i = 0; i < pushSteps; i++) {
        if (this.cranePos.y > 2.8) {
          this.cranePos.y -= 0.0125;
          this.craneBody.setNextKinematicTranslation({ x: this.cranePos.x, y: this.cranePos.y, z: this.cranePos.z });
          await new Promise(r => setTimeout(r, 16));
        }
      }
    }

    this.targetLeftAngle = this.CLOSED_ANGLE; this.targetRightAngle = -this.CLOSED_ANGLE;
    await new Promise(r => setTimeout(r, 2200));

    while (this.cranePos.y < startY) {
      this.cranePos.y += 0.0125;
      this.craneBody.setNextKinematicTranslation({ x: this.cranePos.x, y: this.cranePos.y, z: this.cranePos.z });
      await new Promise(r => setTimeout(r, 16));
    }

    // 元の高さに戻った後、景品をリリースするために一度アームを開いてから閉じる
    this.targetLeftAngle = this.OPEN_ANGLE; this.targetRightAngle = -this.OPEN_ANGLE;
    await new Promise(r => setTimeout(r, 1800)); // 開くのを待つ

    this.targetLeftAngle = this.CLOSED_ANGLE; this.targetRightAngle = -this.CLOSED_ANGLE;
    await new Promise(r => setTimeout(r, 2200)); // 閉じるのを待つ

    this.isDropping = false;
    this.isTouchingSomething = false;
  }

  private resetPosition() {
    this.prizeBody.setTranslation({ x: this.prizeStartPos.x, y: this.prizeStartPos.y, z: this.prizeStartPos.z }, true);
    this.prizeBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.prizeBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.prizeBody.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);

    this.cranePos.set(0, 8.5, 0);
    this.craneBody.setTranslation({ x: 0, y: 8.5, z: 0 }, true);
    this.craneBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.craneBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    
    this.isTouchingSomething = false;
    this.targetLeftAngle = 0.1;
    this.targetRightAngle = -0.1;
    this.currentLeftAngle = 0.1;
    this.currentRightAngle = -0.1;

    [this.leftArmBody, this.rightArmBody].forEach((body, i) => {
      const attach = i === 0 ? { x: -0.5, y: -0.2, z: 0 } : { x: 0.5, y: -0.2, z: 0 };
      body.setTranslation({ x: this.cranePos.x + attach.x, y: this.cranePos.y + attach.y, z: this.cranePos.z }, true);
      body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    });

    // モーター位置をリセット (強力な力で初期位置に戻す)
    this.leftJoint.configureMotorPosition(0.1, 600.0, 15.0);
    this.rightJoint.configureMotorPosition(-0.1, 600.0, 15.0);
  }

  private onWindowResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  private animate() {
    requestAnimationFrame(() => this.animate());

    // preStep 相当の処理
    this.applyArmTorque();
    if (!this.isDropping) {
      this.activeKeys.forEach(id => {
        const dir = (this.buttons as any)[id];
        if (dir) {
          this.cranePos.x += dir.x * 0.02;
          this.cranePos.z += dir.z * 0.02;
        }
      });
      this.craneBody.setNextKinematicTranslation({ x: this.cranePos.x, y: this.cranePos.y, z: this.cranePos.z });
    }

    // 物理シミュレーションを1ステップ進める
    this.world.step(this.eventQueue);

    // 衝突イベントの検知
    this.eventQueue.drainCollisionEvents((handle1, handle2, started) => {
      if (started) {
        const c1 = this.world.getCollider(handle1);
        const c2 = this.world.getCollider(handle2);
        if (c1 && c2) {
          const b1 = c1.parent();
          const b2 = c2.parent();
          if (b1 && b2) {
            const isCraneOrArm = (b: RAPIER.RigidBody) => b === this.craneBody || b === this.leftArmBody || b === this.rightArmBody;
            const isPrize = (b: RAPIER.RigidBody) => b === this.prizeBody;
            if ((isCraneOrArm(b1) && isPrize(b2)) || (isCraneOrArm(b2) && isPrize(b1))) {
              this.isTouchingSomething = true;
            }
          }
        }
      }
    });

    // メッシュの位置・回転の同期
    if (this.prizeMesh) {
      const pos = this.prizeBody.translation();
      const rot = this.prizeBody.rotation();
      this.prizeMesh.position.set(pos.x, pos.y, pos.z);
      this.prizeMesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
    }
    if (this.craneMesh) {
      const pos = this.craneBody.translation();
      const rot = this.craneBody.rotation();
      this.craneMesh.position.set(pos.x, pos.y, pos.z);
      this.craneMesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
    }
    if (this.leftArmGroup) {
      const pos = this.leftArmBody.translation();
      const rot = this.leftArmBody.rotation();
      this.leftArmGroup.position.set(pos.x, pos.y, pos.z);
      this.leftArmGroup.quaternion.set(rot.x, rot.y, rot.z, rot.w);
    }
    if (this.rightArmGroup) {
      const pos = this.rightArmBody.translation();
      const rot = this.rightArmBody.rotation();
      this.rightArmGroup.position.set(pos.x, pos.y, pos.z);
      this.rightArmGroup.quaternion.set(rot.x, rot.y, rot.z, rot.w);
    }

    this.renderer.render(this.scene, this.camera);
  }

  static async init() {
    await RAPIER.init();
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
