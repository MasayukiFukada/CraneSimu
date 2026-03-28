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
  private bridgeBodies: CANNON.Body[] = [];

  // 状態
  private cranePos = new THREE.Vector3(0, 5, 0);
  private craneSpeed = 0.05;
  private isDropping = false;

  constructor() {
    // Three.js 初期化
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf0f0f0);

    const canvas = document.getElementById('canvas') as HTMLCanvasElement;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);

    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.camera.position.set(5, 8, 10);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);

    // 物理ワールド初期化
    this.world = new CANNON.World();
    this.world.gravity.set(0, -9.82, 0);

    this.setupLights();
    this.setupBridge();
    this.setupPrize();
    this.setupCrane();
    this.setupUI();

    this.animate();

    window.addEventListener('resize', () => this.onWindowResize());
  }

  private setupLights() {
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(5, 10, 5);
    this.scene.add(directionalLight);
  }

  private setupBridge() {
    // 2本の平行な棒
    const bridgeGeo = new THREE.CylinderGeometry(0.1, 0.1, 10, 16);
    const bridgeMat = new THREE.MeshPhongMaterial({ color: 0x888888 });

    const createRod = (z: number) => {
      const rod = new THREE.Mesh(bridgeGeo, bridgeMat);
      rod.rotation.z = Math.PI / 2;
      rod.position.set(0, 3, z);
      this.scene.add(rod);

      const shape = new CANNON.Cylinder(0.1, 0.1, 10, 16);
      const body = new CANNON.Body({ mass: 0, type: CANNON.Body.STATIC });
      body.addShape(shape, new CANNON.Vec3(0, 0, 0), new CANNON.Quaternion().setFromAxisAngle(new CANNON.Vec3(0, 0, 1), Math.PI / 2));
      body.position.set(0, 3, z);
      this.world.addBody(body);
      this.bridgeBodies.push(body);
    };

    createRod(-1);
    createRod(1);
  }

  private setupPrize() {
    const size = { x: 1.5, y: 1, z: 2.5 };
    const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
    const material = new THREE.MeshPhongMaterial({ color: 0xffaa00 });
    this.prizeMesh = new THREE.Mesh(geometry, material);
    this.scene.add(this.prizeMesh);

    const shape = new CANNON.Box(new CANNON.Vec3(size.x / 2, size.y / 2, size.z / 2));
    this.prizeBody = new CANNON.Body({ mass: 1 });
    this.prizeBody.addShape(shape);
    this.prizeBody.position.set(0, 4, 0); // 橋の上に置く
    this.world.addBody(this.prizeBody);
  }

  private setupCrane() {
    // クレーン本体の簡易モデル
    this.craneMesh = new THREE.Group();
    const bodyGeo = new THREE.SphereGeometry(0.5, 16, 16);
    const bodyMat = new THREE.MeshPhongMaterial({ color: 0x4444ff });
    const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
    this.craneMesh.add(bodyMesh);

    // アーム（ツメ）
    const armGeo = new THREE.BoxGeometry(0.1, 1.5, 0.5);
    const leftArm = new THREE.Mesh(armGeo, bodyMat);
    leftArm.position.set(-0.6, -0.75, 0);
    leftArm.rotation.z = 0.2;
    this.craneMesh.add(leftArm);

    const rightArm = new THREE.Mesh(armGeo, bodyMat);
    rightArm.position.set(0.6, -0.75, 0);
    rightArm.rotation.z = -0.2;
    this.craneMesh.add(rightArm);

    this.scene.add(this.craneMesh);

    // 物理体としてのクレーン（簡易的に1つの球体として扱う）
    const shape = new CANNON.Sphere(0.5);
    this.craneBody = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC });
    this.craneBody.addShape(shape);
    this.world.addBody(this.craneBody);
  }

  private setupUI() {
    const buttons = {
      'btn-left': { x: -1, z: 0 },
      'btn-right': { x: 1, z: 0 },
      'btn-forward': { x: 0, z: -1 },
      'btn-backward': { x: 0, z: 1 },
    };

    const activeKeys = new Set<string>();

    Object.entries(buttons).forEach(([id, dir]) => {
      const btn = document.getElementById(id);
      if (btn) {
        btn.addEventListener('mousedown', () => activeKeys.add(id));
        btn.addEventListener('mouseup', () => activeKeys.delete(id));
        btn.addEventListener('mouseleave', () => activeKeys.delete(id));
        // タッチイベント対応
        btn.addEventListener('touchstart', (e) => { e.preventDefault(); activeKeys.add(id); });
        btn.addEventListener('touchend', () => activeKeys.delete(id));
      }
    });

    const dropBtn = document.getElementById('btn-drop');
    dropBtn?.addEventListener('click', () => this.startDropSequence());

    const resetBtn = document.getElementById('btn-reset');
    resetBtn?.addEventListener('click', () => this.resetPosition());

    // 毎フレームの移動処理
    this.world.addEventListener('preStep', () => {
      if (this.isDropping) return;

      activeKeys.forEach(id => {
        const dir = buttons[id as keyof typeof buttons];
        this.cranePos.x += dir.x * this.craneSpeed;
        this.cranePos.z += dir.z * this.craneSpeed;
      });

      this.craneBody.position.set(this.cranePos.x, this.cranePos.y, this.cranePos.z);
    });
  }

  private async startDropSequence() {
    if (this.isDropping) return;
    this.isDropping = true;

    // 1. 降下
    const startY = this.cranePos.y;
    const targetY = 3.5;
    for (let y = startY; y > targetY; y -= 0.05) {
      this.cranePos.y = y;
      this.craneBody.position.y = y;
      await new Promise(r => setTimeout(r, 16));
    }

    // 2. 少し待機（掴む動作の代わり）
    await new Promise(r => setTimeout(r, 500));

    // 3. 上昇
    for (let y = targetY; y < startY; y += 0.05) {
      this.cranePos.y = y;
      this.craneBody.position.y = y;
      await new Promise(r => setTimeout(r, 16));
    }

    this.isDropping = false;
  }

  private resetPosition() {
    this.prizeBody.position.set(0, 4, 0);
    this.prizeBody.velocity.set(0, 0, 0);
    this.prizeBody.angularVelocity.set(0, 0, 0);
    this.prizeBody.quaternion.set(0, 0, 0, 1);

    this.cranePos.set(0, 5, 0);
    this.craneBody.position.set(0, 5, 0);
  }

  private onWindowResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  private animate() {
    requestAnimationFrame(() => this.animate());

    // 物理演算の更新
    this.world.fixedStep();

    // 物理体の位置をメッシュに反映
    this.prizeMesh.position.copy(this.prizeBody.position as any);
    this.prizeMesh.quaternion.copy(this.prizeBody.quaternion as any);

    this.craneMesh.position.copy(this.craneBody.position as any);

    this.renderer.render(this.scene, this.camera);
  }
}

new CraneSimulator();
