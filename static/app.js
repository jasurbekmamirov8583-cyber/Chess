import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Chess } from 'https://cdn.jsdelivr.net/npm/chess.js@1.0.0/+esm';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const tg = window.Telegram?.WebApp;
const SESSION_STORAGE_KEY='zamin-session-v1',ACTIVE_GAME_KEY='zamin-active-game-v1';
const storedValue=key=>{try{return localStorage.getItem(key)||''}catch{return ''}};
const storeValue=(key,value)=>{try{if(value)localStorage.setItem(key,value);else localStorage.removeItem(key)}catch{}};
let savedBoardMode='3d';try{savedBoardMode=localStorage.getItem('zamin-board-mode')||'3d'}catch{}
const state = {
  config: null, token: '', user: null, profile: null, game: null,
  socket: null, socketPing: null, board: null, board3d: null, board2d: null, heroArena: null, boardMode: savedBoardMode==='2d'?'2d':'3d', chess: new Chess(),
  selected: null, legal: [], sound: true, mode: 'friend', aiLevel: 2,
  time: 600, increment: 3, variant: 'standard', casual: false, seriesBestOf: 3, opponentId: '', shareUrl: '', moving: false, aiThinking: false, timeoutClaimed: false, pendingChallenge: '', realtimeLive: false,
  premove: null, selectionMode: 'move', spectator: false, replaying: false, historyPly: null, resultSynced: false, resultPresented: false,
  theme: 'registan', performanceMode: 'auto', boardPalette: 'pro_green', pieceStyle: 'staunton', boardShape: 'tournament',
  presence: {players:0,spectators:0}, puzzle: null, puzzleStartedAt: 0,
};

const PUZZLES=[
  {id:'silk-mate',title:'Ipak yo‘li moti',fen:'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4',solution:'h5f7',hint:'Vazir va fil f7 nuqtasiga birga qaramoqda.'},
  {id:'tower-gate',title:'Qal’a darvozasi',fen:'6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1',solution:'e1e8',hint:'Oxirgi gorizontalda shohning qochish katagi yo‘q.'},
  {id:'desert-fork',title:'Sahrodagi toj',fen:'7k/6pp/5KQ1/8/8/8/8/8 w - - 0 1',solution:'g6g7',hint:'Vazir piyodani olsa, oq shoh uni himoya qiladi.'},
  {id:'ice-backrank',title:'Muzlik minorasi',fen:'7k/5K2/8/8/8/8/8/R7 w - - 0 1',solution:'a1a8',hint:'Tura sakkizinchi qatorni to‘liq nazorat qila oladi.'},
  {id:'registan-pin',title:'Registon taxti',fen:'k7/8/1QK5/8/8/8/8/8 w - - 0 1',solution:'b6b7',hint:'Vazir qora shohning uchala qochish katagini yopsin.'},
];

if (tg) {
  tg.ready(); tg.expand();
  tg.setHeaderColor?.('#07090d'); tg.setBackgroundColor?.('#07090d');
  tg.disableVerticalSwipes?.();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {'Content-Type': 'application/json', ...(state.token ? {Authorization: `Bearer ${state.token}`} : {}), ...options.headers},
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.detail || 'Server bilan aloqa uzildi');
  return data;
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`; el.textContent = message;
  $('#toast-stack').append(el);
  setTimeout(() => el.remove(), 3400);
  tg?.HapticFeedback?.notificationOccurred?.(kind === 'error' ? 'error' : 'success');
}

function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(node) { node.closest('.modal-backdrop')?.classList.add('hidden'); }
function setLoading(button, active, text = 'KUTILMOQDA...') {
  if (!button) return;
  if (active) { button.dataset.old = button.textContent; button.disabled = true; button.textContent = text; }
  else { button.disabled = false; button.textContent = button.dataset.old || button.textContent; }
}

class AudioForge {
  constructor() { this.ctx = null; this.master = null; this.reverb = null; }
  wake() {
    if (!this.ctx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      this.ctx = new AudioContext();
      this.master = this.ctx.createDynamicsCompressor();
      this.master.threshold.value = -18; this.master.knee.value = 18; this.master.ratio.value = 5;
      this.master.connect(this.ctx.destination);
      this.reverb = this.ctx.createConvolver();
      const length = Math.floor(this.ctx.sampleRate * .65), impulse = this.ctx.createBuffer(2, length, this.ctx.sampleRate);
      for (let channel=0; channel<2; channel++) {
        const data=impulse.getChannelData(channel);
        for (let i=0;i<length;i++) data[i]=(Math.random()*2-1)*Math.pow(1-i/length,2.7);
      }
      this.reverb.buffer=impulse; this.reverb.connect(this.master);
    }
    this.ctx.resume();
  }
  tone(freq, duration, type='sine', volume=.06, slide=0, delay=0, wet=.15) {
    if (!state.sound) return;
    this.wake(); if(!this.ctx)return; const t=this.ctx.currentTime+delay;
    const osc=this.ctx.createOscillator(), gain=this.ctx.createGain(), dry=this.ctx.createGain(), send=this.ctx.createGain();
    osc.type=type; osc.frequency.setValueAtTime(freq,t); osc.frequency.exponentialRampToValueAtTime(Math.max(25,freq+slide),t+duration);
    gain.gain.setValueAtTime(.001,t); gain.gain.exponentialRampToValueAtTime(volume,t+.012); gain.gain.exponentialRampToValueAtTime(.001,t+duration);
    dry.gain.value=1-wet;send.gain.value=wet;osc.connect(gain);gain.connect(dry).connect(this.master);gain.connect(send).connect(this.reverb);osc.start(t);osc.stop(t+duration+.02);
  }
  noise(duration=.1, volume=.04, highpass=500, delay=0) {
    if(!state.sound)return;this.wake();if(!this.ctx)return;const t=this.ctx.currentTime+delay,length=Math.floor(this.ctx.sampleRate*duration),buffer=this.ctx.createBuffer(1,length,this.ctx.sampleRate),data=buffer.getChannelData(0);
    for(let i=0;i<length;i++)data[i]=(Math.random()*2-1)*Math.pow(1-i/length,2);
    const source=this.ctx.createBufferSource(),filter=this.ctx.createBiquadFilter(),gain=this.ctx.createGain();source.buffer=buffer;filter.type='highpass';filter.frequency.value=highpass;gain.gain.setValueAtTime(volume,t);gain.gain.exponentialRampToValueAtTime(.001,t+duration);source.connect(filter).connect(gain).connect(this.master);source.start(t);
  }
  woodKnock(delay=0,strength=1){this.tone(178,.055,'triangle',.075*strength,-105,delay,.015);this.tone(92,.082,'sine',.062*strength,-34,delay+.007,.01);this.noise(.032,.018*strength,760,delay+.004)}
  move() { this.woodKnock(0,.88); }
  capture() { this.woodKnock(0,.72);this.woodKnock(.075,1.08); }
  check() { this.tone(510,.09,'triangle',.032,-145,.035,.06);this.noise(.025,.012,1200,.04); }
  draw() { this.woodKnock(0,.62);this.woodKnock(.13,.62); }
  defeat() { this.woodKnock(0,.85);this.tone(105,.18,'sine',.04,-38,.1,.04); }
  victory() { this.woodKnock(0,.7);this.woodKnock(.11,.82);this.woodKnock(.22,1); }
}
const audio = new AudioForge();

class ChessArena3D {
  constructor(container, {interactive = true, hero = false} = {}) {
    this.container = container; this.interactive = interactive; this.hero = hero;
    this.active = true;this.disposed=false;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(hero ? 34 : 40, 1, .1, 100);
    this.camera.position.set(hero ? 5.8 : 0, hero ? 6.3 : 8.4, hero ? 6.8 : 8.1);
    this.renderer = new THREE.WebGLRenderer({
      antialias: state.performanceMode!=='battery', alpha: true,
      powerPreference: state.performanceMode==='battery'?'low-power':'high-performance'
    });
    const pixelCap=state.performanceMode==='battery'?1:state.performanceMode==='quality'?2.25:hero?1.35:innerWidth<700?1.75:2;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio,pixelCap));
    this.renderer.shadowMap.enabled=state.performanceMode!=='battery';this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace; this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.32;
    container.append(this.renderer.domElement);
    this.root = new THREE.Group(); this.scene.add(this.root);
    this.pieces = new Map(); this.pieceTemplates=new Map();this.squares = []; this.markers = [];this.positionMarkers=[];
    this.raycaster = new THREE.Raycaster(); this.pointer = new THREE.Vector2();
    this.buildLights(); this.buildBoard();
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 0); this.controls.enablePan = false;
    this.controls.enableZoom = interactive; this.controls.minDistance = 6.5; this.controls.maxDistance = 24;
    this.controls.minPolarAngle = .48; this.controls.maxPolarAngle = 1.25;
    this.controls.autoRotate = hero; this.controls.autoRotateSpeed = .7;
    this.controls.enableDamping = true; this.controls.dampingFactor = .06;
    if (interactive) {
      let pointerStart=null;
      this.renderer.domElement.addEventListener('pointerdown',e=>pointerStart={x:e.clientX,y:e.clientY});
      this.renderer.domElement.addEventListener('pointerup',e=>{if(pointerStart&&Math.hypot(e.clientX-pointerStart.x,e.clientY-pointerStart.y)<7)this.pick(e);pointerStart=null});
    }
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(container);
    this.lastFrame=0;this.frameInterval=1000/(state.performanceMode==='battery'?24:state.performanceMode==='quality'?60:hero?30:45);this.loop();
  }
  buildLights() {
    this.scene.add(new THREE.HemisphereLight(0xffffff,0x73919c,2.65));
    const key=new THREE.SpotLight(0xfff1d2,148,34,.58,.68);key.position.set(-5,11,6);key.castShadow=true;const shadowSize=state.performanceMode==='battery'?512:state.performanceMode==='quality'&&!this.hero?1536:this.hero?512:1024;key.shadow.mapSize.set(shadowSize,shadowSize);key.shadow.bias=-.00025;this.scene.add(key);
    const cool=new THREE.SpotLight(0xc9f9ff,126,30,.7,.72);cool.position.set(6,8,-5);this.scene.add(cool);
    const front=new THREE.DirectionalLight(0xffffff,2.35);front.position.set(0,5,8);this.scene.add(front);
    const rim=new THREE.PointLight(0xffa65e,42,20);rim.position.set(-6,3,-3);this.scene.add(rim);
  }
  buildBoard() {
    const palettes={pro_green:[0xEEEED2,0x769656,0x6F4932],walnut:[0xF0D9B5,0xB58863,0x68452F],slate:[0xD8E4E7,0x66818E,0x3F535D],contrast:[0xF4F1E8,0x52705D,0x252F35]},palette=palettes[state.boardPalette]||palettes.pro_green;
    const floating=state.boardShape==='floating',soft=state.boardShape==='soft',baseColor=floating?0x2b3336:palette[2];
    const baseMat=new THREE.MeshPhysicalMaterial({color:baseColor,roughness:soft?.38:.3,metalness:floating?.48:.18,clearcoat:soft?.82:.55});
    const base=new THREE.Mesh(new THREE.BoxGeometry(floating?9.18:9.45,floating?.22:.38,floating?9.18:9.45),baseMat);base.position.y=floating?-.21:-.28;base.receiveShadow=true;this.root.add(base);
    if(floating){const shadowBase=new THREE.Mesh(new THREE.BoxGeometry(8.65,.13,8.65),new THREE.MeshStandardMaterial({color:0x111719,metalness:.6,roughness:.3}));shadowBase.position.y=-.39;this.root.add(shadowBase)}
    const rim=new THREE.Mesh(new THREE.BoxGeometry(8.72,.16,8.72),new THREE.MeshStandardMaterial({color:palette[2],metalness:.78,roughness:.28}));rim.position.y=-.035;this.root.add(rim);
    const light=new THREE.MeshPhysicalMaterial({color:palette[0],roughness:.42,metalness:.04,clearcoat:.28});
    const dark=new THREE.MeshPhysicalMaterial({color:palette[1],roughness:.36,metalness:.18,clearcoat:.4});
    const squareGeometry=new THREE.BoxGeometry(.985,.14,.985);
    for (let r=0;r<8;r++) for(let f=0;f<8;f++) {
      const mesh=new THREE.Mesh(squareGeometry,(f+r)%2?dark:light);
      const square = `${'abcdefgh'[f]}${r+1}`;
      mesh.position.set(f-3.5,.065,3.5-r);mesh.receiveShadow=true;mesh.userData.square=square;
      this.root.add(mesh); this.squares.push(mesh);
    }
    const floorColors={pro_green:0x464642,walnut:0x51463f,slate:0x3f4b50,contrast:0x3c4240};
    const floor=new THREE.Mesh(new THREE.CircleGeometry(12,64),new THREE.MeshStandardMaterial({color:floorColors[state.boardPalette]||floorColors.pro_green,transparent:true,opacity:.96,roughness:1}));floor.rotation.x=-Math.PI/2;floor.position.y=-.49;floor.receiveShadow=true;this.scene.add(floor);
  }
  material(color) {
    const modern=state.pieceStyle==='modern',royal=state.pieceStyle==='royal';
    return color==='w'
      ? new THREE.MeshPhysicalMaterial({color:modern?0xf7f7f1:0xf0e6d2,roughness:modern?.34:.22,metalness:royal?.2:.06,clearcoat:royal?1:.68,clearcoatRoughness:.12})
      : new THREE.MeshPhysicalMaterial({color:modern?0x20282c:0x151b1e,emissive:0x3e5963,emissiveIntensity:modern?.28:.38,roughness:modern?.32:.24,metalness:royal?.42:.18,clearcoat:royal?1:.7,clearcoatRoughness:.1});
  }
  accent(color='w') { return new THREE.MeshStandardMaterial({color:color==='w'?0xe7a943:0xe66d42,metalness:.9,roughness:.18}); }
  gold() { return this.accent('w'); }
  part(geometry, material, y, group, scale=1) {
    const m = new THREE.Mesh(geometry, material); m.position.y=y; m.scale.setScalar(scale); m.castShadow=true; m.receiveShadow=true; group.add(m); return m;
  }
  lathe(profile,material,group,segments=36){const geometry=new THREE.LatheGeometry(profile.map(([r,y])=>new THREE.Vector2(r,y)),segments);const mesh=new THREE.Mesh(geometry,material);mesh.castShadow=true;mesh.receiveShadow=true;group.add(mesh);return mesh}
  ring(radius,y,material,group,tube=.035){const ring=this.part(new THREE.TorusGeometry(radius,tube,10,32),material,y,group);ring.rotation.x=Math.PI/2;return ring}
  base(material,accent,group){this.lathe([[0,.04],[.38,.04],[.47,.1],[.49,.17],[.43,.24],[.32,.29],[.29,.34]],material,group);this.ring(.345,.27,accent,group,.035)}
  piece(type, color) {
    const templateKey=`${type}:${color}:${state.pieceStyle}:${Math.floor(Number(state.profile?.army_xp||0)/120)}`;
    const cached=this.pieceTemplates.get(templateKey);
    if(cached){const clone=cached.clone(true);clone.traverse(object=>{object.userData={...object.userData,pieceRoot:clone}});return clone}
    const g=new THREE.Group(),m=this.material(color),accent=this.accent(color);this.base(m,accent,g);
    if(type==='p'){
      this.lathe([[.28,.31],[.23,.39],[.15,.53],[.14,.68],[.19,.76]],m,g);this.ring(.19,.76,accent,g,.028);this.part(new THREE.SphereGeometry(.235,28,20),m,1.01,g);
    } else if(type==='r'){
      this.lathe([[.3,.31],[.28,.42],[.25,.78],[.33,.87],[.38,.96]],m,g,24);this.ring(.33,.88,accent,g,.032);this.part(new THREE.CylinderGeometry(.39,.37,.2,8),m,1.04,g);
      for(let i=0;i<4;i++){const tooth=this.part(new THREE.BoxGeometry(.19,.2,.2),m,1.22,g);tooth.position.x=Math.cos(i*Math.PI/2+.4)*.27;tooth.position.z=Math.sin(i*Math.PI/2+.4)*.27;}
    } else if(type==='n'){
      this.lathe([[.29,.31],[.32,.43],[.29,.54],[.24,.64]],m,g,32);
      const profile=new THREE.Shape();
      profile.moveTo(-.28,-.52);profile.bezierCurveTo(-.31,-.3,-.27,-.08,-.15,.1);profile.bezierCurveTo(-.04,.27,-.03,.43,-.08,.57);profile.lineTo(-.17,.79);profile.lineTo(-.01,.72);profile.lineTo(.09,.56);profile.bezierCurveTo(.27,.49,.39,.36,.43,.2);profile.lineTo(.61,.1);profile.bezierCurveTo(.67,.04,.62,-.05,.5,-.08);profile.lineTo(.29,-.12);profile.bezierCurveTo(.23,-.27,.2,-.4,.2,-.52);profile.closePath();
      const horseGeometry=new THREE.ExtrudeGeometry(profile,{depth:.38,steps:1,curveSegments:18,bevelEnabled:true,bevelSegments:4,bevelSize:.045,bevelThickness:.045});horseGeometry.center();
      const horse=new THREE.Mesh(horseGeometry,m);horse.position.set(-.02,1.17,-.19);horse.castShadow=true;horse.receiveShadow=true;g.add(horse);
      for(const side of [-1,1]){const ear=this.part(new THREE.ConeGeometry(.065,.25,14),m,1.72,g);ear.position.set(-.08,1.72,side*.115);ear.rotation.z=-.18;const eye=this.part(new THREE.SphereGeometry(.034,14,10),accent,1.47,g);eye.position.set(.12,1.47,side*.225)}
      for(const [x,y,rotation] of [[-.23,1.48,-.42],[-.28,1.33,-.32],[-.29,1.18,-.2],[-.27,1.03,-.08]]){const tuft=this.part(new THREE.ConeGeometry(.065,.2,10),accent,y,g);tuft.position.x=x;tuft.rotation.z=rotation}
      for(const side of [-1,1]){const nostril=this.part(new THREE.SphereGeometry(.024,10,8),accent,1.28,g);nostril.position.set(.4,1.28,side*.16)}
      const jaw=this.part(new THREE.TorusGeometry(.2,.025,8,24,Math.PI*.78),accent,1.24,g);jaw.position.x=.25;jaw.rotation.set(Math.PI/2,0,-.18);
    } else if(type==='b'){
      this.lathe([[.29,.31],[.3,.4],[.18,.58],[.15,.82],[.23,.91]],m,g);this.ring(.225,.91,accent,g,.032);
      const crown=this.part(new THREE.SphereGeometry(.25,30,22),m,1.16,g);crown.scale.set(.86,1.25,.86);const slash=this.part(new THREE.BoxGeometry(.055,.46,.3),accent,1.19,g);slash.rotation.z=-.48;this.part(new THREE.SphereGeometry(.065,16,12),accent,1.49,g);
    } else if(type==='q'){
      this.lathe([[.29,.31],[.31,.42],[.2,.61],[.17,.93],[.28,1.05],[.32,1.13]],m,g);this.ring(.31,1.1,accent,g,.04);
      for(let i=0;i<7;i++){const a=i*Math.PI*2/7,spike=this.part(new THREE.ConeGeometry(.075,.34,12),m,1.31,g);spike.position.x=Math.cos(a)*.27;spike.position.z=Math.sin(a)*.27;spike.rotation.z=Math.cos(a)*.22;spike.rotation.x=-Math.sin(a)*.22;this.part(new THREE.SphereGeometry(.065,14,10),accent,1.49,g).position.set(Math.cos(a)*.3,1.49,Math.sin(a)*.3);}
      this.part(new THREE.SphereGeometry(.1,18,12),accent,1.47,g);
    } else {
      this.lathe([[.29,.31],[.32,.42],[.21,.61],[.18,.98],[.3,1.08],[.28,1.19],[.18,1.28]],m,g);this.ring(.29,1.1,accent,g,.042);this.part(new THREE.SphereGeometry(.13,18,12),m,1.38,g);
      this.part(new THREE.BoxGeometry(.105,.48,.105),accent,1.62,g);this.part(new THREE.BoxGeometry(.39,.105,.105),accent,1.67,g);
    }
    const evolution=Math.floor(Number(state.profile?.army_xp||0)/120)+1;
    if(evolution>=3&&type!=='p'){const aura=this.ring(.43,.08,new THREE.MeshBasicMaterial({color:evolution>=6?0x69f2ff:0xffc766,transparent:true,opacity:.34}),g,.018);aura.userData.aura=true}
    if(evolution>=5&&['q','k'].includes(type)){const gem=this.part(new THREE.OctahedronGeometry(.075),accent,type==='k'?1.91:1.7,g);gem.rotation.y=.5}
    const baseScale=type==='p'?.73:.71;
    if(state.pieceStyle==='modern')g.scale.set(baseScale*1.04,baseScale*.94,baseScale*1.04);
    else if(state.pieceStyle==='royal')g.scale.set(baseScale*.97,baseScale*1.08,baseScale*.97);
    else g.scale.setScalar(baseScale);
    g.rotation.y=color==='b'?Math.PI:0;
    this.pieceTemplates.set(templateKey,g);const clone=g.clone(true);clone.traverse(object=>{object.userData={...object.userData,pieceRoot:clone}});return clone;
  }
  squarePosition(square) { return new THREE.Vector3(square.charCodeAt(0)-97-3.5,.14,3.5-(Number(square[1])-1)); }
  release(object){object.traverse(child=>{child.geometry?.dispose?.();if(Array.isArray(child.material))child.material.forEach(material=>material.dispose?.());else child.material?.dispose?.()})}
  load(fen) {
    for(const p of this.pieces.values())this.root.remove(p);this.pieces.clear();
    const chess = new Chess(fen);
    for(const row of chess.board()) for(const p of row) if(p) {
      const square=`${'abcdefgh'[p.square.charCodeAt(0)-97]}${p.square[1]}`;
      const model=this.piece(p.type,p.color); model.position.copy(this.squarePosition(square));
      model.userData={...model.userData,square,color:p.color,type:p.type}; this.root.add(model);this.pieces.set(square,model);
    }
  }
  commitMove(uci,fen){
    const from=uci.slice(0,2),to=uci.slice(2,4),mover=this.pieces.get(from);if(!mover){this.load(fen);return}
    const targetOccupied=this.pieces.has(to),removeAt=square=>{const piece=this.pieces.get(square);if(piece&&piece!==mover){this.root.remove(piece);this.pieces.delete(square)}};
    removeAt(to);
    if(mover.userData.type==='p'&&from[0]!==to[0]&&!targetOccupied)removeAt(`${to[0]}${from[1]}`);
    if(mover.userData.type==='k'&&Math.abs(from.charCodeAt(0)-to.charCodeAt(0))===2){const kingSide=to[0]==='g',rookFrom=`${kingSide?'h':'a'}${from[1]}`,rookTo=`${kingSide?'f':'d'}${from[1]}`,rook=this.pieces.get(rookFrom);if(rook){this.pieces.delete(rookFrom);this.pieces.set(rookTo,rook);rook.position.copy(this.squarePosition(rookTo));rook.userData.square=rookTo}}
    this.pieces.delete(from);
    if(uci[4]){const promoted=this.piece(uci[4],mover.userData.color);this.root.remove(mover);promoted.position.copy(this.squarePosition(to));promoted.userData={...promoted.userData,square:to,color:mover.userData.color,type:uci[4]};this.root.add(promoted);this.pieces.set(to,promoted);return}
    mover.position.copy(this.squarePosition(to));mover.rotation.z=0;const baseScale=mover.userData.type==='p'?.73:.71;if(state.pieceStyle==='modern')mover.scale.set(baseScale*1.04,baseScale*.94,baseScale*1.04);else if(state.pieceStyle==='royal')mover.scale.set(baseScale*.97,baseScale*1.08,baseScale*.97);else mover.scale.setScalar(baseScale);mover.userData.square=to;this.pieces.set(to,mover);
  }
  orient(color='white') {
    this.viewColor=color;
    const rect=this.container.getBoundingClientRect(),aspect=Math.max(.45,rect.width/Math.max(1,rect.height));
    const distance=this.hero?7.2:(aspect<.95?Math.min(16.5,9.4/aspect):8.7),sign=color==='black'?-1:1;
    this.camera.position.set(0,distance*.94,sign*distance);this.controls.target.set(0,.18,0);this.controls.update();
  }
  showMoves(selected, destinations=[]) {
    this.clearMarkers();
    const add=(sq,color,size=.18)=>{const marker=new THREE.Mesh(new THREE.CylinderGeometry(size,size,.035,32),new THREE.MeshBasicMaterial({color,transparent:true,opacity:.78}));marker.position.copy(this.squarePosition(sq));marker.position.y=.19;this.root.add(marker);this.markers.push(marker)};
    if(selected) add(selected,0xf0c979,.38);
    destinations.forEach(sq=>add(sq,this.pieces.has(sq) ? 0xd6534e : 0x86bd8d,this.pieces.has(sq) ? .26 : .14));
  }
  clearMarkers(){this.markers.forEach(marker=>{this.root.remove(marker);this.release(marker)});this.markers=[]}
  showPositionHighlights(lastMove='',checkSquare=''){
    this.positionMarkers.forEach(marker=>{this.root.remove(marker);this.release(marker)});this.positionMarkers=[];
    const add=(square,color,opacity)=>{if(!square)return;const marker=new THREE.Mesh(new THREE.PlaneGeometry(.97,.97),new THREE.MeshBasicMaterial({color,transparent:true,opacity,depthWrite:false,side:THREE.DoubleSide}));marker.rotation.x=-Math.PI/2;marker.position.copy(this.squarePosition(square));marker.position.y=.143;marker.userData.square=square;this.root.add(marker);this.positionMarkers.push(marker)};
    if(lastMove){add(lastMove.slice(0,2),0xf2b94b,.24);add(lastMove.slice(2,4),0x69d6db,.34)}
    if(checkSquare){add(checkSquare,0xff2638,.68);const ring=new THREE.Mesh(new THREE.RingGeometry(.28,.43,32),new THREE.MeshBasicMaterial({color:0xff6974,transparent:true,opacity:.95,side:THREE.DoubleSide,depthWrite:false}));ring.rotation.x=-Math.PI/2;ring.position.copy(this.squarePosition(checkSquare));ring.position.y=.19;ring.userData.square=checkSquare;this.root.add(ring);this.positionMarkers.push(ring)}
  }
  pick(event) {
    if(state.moving) return;
    const rect=this.renderer.domElement.getBoundingClientRect();this.pointer.x=((event.clientX-rect.left)/rect.width)*2-1;this.pointer.y=-((event.clientY-rect.top)/rect.height)*2+1;
    this.raycaster.setFromCamera(this.pointer,this.camera);const hits=this.raycaster.intersectObjects(this.root.children,true);
    for(const hit of hits){let obj=hit.object,square=obj.userData.square;while(!square&&obj.parent){obj=obj.parent;square=obj.userData.square}if(square){onSquare(square);break}}
  }
  weapon(kind='sword') {
    const g=new THREE.Group(), metal=new THREE.MeshStandardMaterial({color:0xd9dce3,metalness:.95,roughness:.12}), wood=new THREE.MeshStandardMaterial({color:0x744727,roughness:.55});
    if(kind==='hammer'){const head=new THREE.Mesh(new THREE.BoxGeometry(.5,.24,.25),metal);head.position.y=.7;g.add(head)}
    else if(kind==='lance'||kind==='spear'){const shaft=new THREE.Mesh(new THREE.CylinderGeometry(.025,.035,.86,10),wood);shaft.position.y=.4;g.add(shaft);const tip=new THREE.Mesh(new THREE.ConeGeometry(kind==='lance'?.09:.07,.32,12),metal);tip.position.y=.98;g.add(tip)}
    else if(kind==='staff'){const shaft=new THREE.Mesh(new THREE.CylinderGeometry(.035,.045,.85,10),wood);shaft.position.y=.38;g.add(shaft);const orb=new THREE.Mesh(new THREE.SphereGeometry(.1,14,10),this.gold());orb.position.y=.86;g.add(orb)}
    else {const blade=new THREE.Mesh(new THREE.BoxGeometry(.08,.7,.035),metal);blade.position.y=.65;g.add(blade);const guard=new THREE.Mesh(new THREE.BoxGeometry(.35,.06,.07),this.gold());guard.position.y=.29;g.add(guard)}
    if(!['lance','spear','staff'].includes(kind)){const handle=new THREE.Mesh(new THREE.CylinderGeometry(.045,.045,.35,10),wood);handle.position.y=.13;g.add(handle)}g.traverse(o=>o.castShadow=true);return g;
  }
  async animateMove(uci, captured=false) {
    const from=uci.slice(0,2),to=uci.slice(2,4),mover=this.pieces.get(from);if(!mover){this.load(state.game.fen);return}
    const start=mover.position.clone(),end=this.squarePosition(to),victim=this.pieces.get(to),victimScale=victim?.scale.clone();
    let weapon=null;if(captured){const arsenal={r:'hammer',n:'lance',b:'staff',p:'spear'};weapon=this.weapon(arsenal[mover.userData.type]||'sword');weapon.position.set(0,.65,.05);weapon.rotation.z=-1.5;mover.add(weapon);audio.capture()}else audio.move();
    const duration=captured?185:95,t0=performance.now();
    await new Promise(resolve=>{const tick=(time)=>{const p=Math.min(1,(time-t0)/duration),ease=1-Math.pow(1-p,3);mover.position.lerpVectors(start,end,ease);mover.position.y=.14+Math.sin(p*Math.PI)*(captured ? .34 : .16);if(weapon)weapon.rotation.z=-1.5+p*3.1;if(victim&&p>.42){const q=(p-.42)/.58;victim.rotation.z=q*1.3;victim.scale.copy(victimScale).multiplyScalar(Math.max(.05,1-q*.95));victim.position.y=.14-q*.45}p<1?requestAnimationFrame(tick):resolve()};requestAnimationFrame(tick)});
    if(weapon){mover.remove(weapon);this.release(weapon)}
  }
  finishEffect(kind,loserColor=''){
    const loser=[...this.pieces.values()].find(piece=>piece.userData.type==='k'&&piece.userData.color===loserColor);
    if(!loser||kind==='draw')return;
    const start=performance.now(),direction=loserColor==='w'?-1:1,baseScale=loser.scale.clone();
    const animate=time=>{const p=Math.min(1,(time-start)/620),ease=1-Math.pow(1-p,3),factor=1-.07*ease;loser.rotation.z=direction*1.18*ease;loser.position.y=.14-.12*ease;loser.scale.copy(baseScale).multiplyScalar(factor);if(p<1)requestAnimationFrame(animate)};
    requestAnimationFrame(animate);
  }
  resize(){const w=this.container.clientWidth,h=this.container.clientHeight;if(!w||!h)return;this.renderer.setSize(w,h,false);this.camera.aspect=w/h;this.camera.updateProjectionMatrix();if(!this.hero)this.orient(this.viewColor||'white')}
  dispose(){this.disposed=true;this.active=false;this.resizeObserver?.disconnect();this.controls?.dispose();this.release(this.scene);this.renderer.dispose();this.renderer.domElement.remove()}
  loop(time=performance.now()){if(this.disposed)return;requestAnimationFrame(next=>this.loop(next));if(!this.active||time-this.lastFrame<this.frameInterval)return;this.lastFrame=time;this.controls.update();if(this.hero)this.root.position.y=Math.sin(time/900)*.04;this.renderer.render(this.scene,this.camera)}
}

function pieceSvg(type,color){
  const shapes={
    p:'<circle class="piece-body" cx="50" cy="25" r="13"/><path class="piece-body" d="M37 42h26c-1 12-6 17-10 21h12l7 14H28l7-14h12c-5-4-9-9-10-21Z"/><path class="piece-line" d="M34 63h32M28 78h44"/>',
    r:'<path class="piece-body" d="M25 17h11v9h9v-9h10v9h9v-9h11v20l-8 7 4 29 8 8H21l8-8 4-29-8-7Z"/><path class="piece-line" d="M30 39h40M29 72h42M22 81h56"/>',
    n:'<path class="piece-body" d="M27 79h51l-8-11-5-30C62 23 54 15 39 12l4 11C32 28 27 39 25 52l17-10 11 5-5 9c-9 7-15 13-21 23Z"/><path class="piece-line" d="M27 79h51M42 42c5-5 11-8 18-9"/><circle class="piece-accent" cx="48" cy="29" r="3"/>',
    b:'<path class="piece-body" d="M50 12c10 9 16 19 12 29-2 6-7 10-12 14 9 2 15 8 16 18l10 8H24l10-8c1-10 7-16 16-18-7-5-12-11-12-19 0-9 5-17 12-24Z"/><path class="piece-line" d="m45 25 12 17M34 72h32M24 81h52"/>',
    q:'<circle class="piece-body" cx="22" cy="22" r="5"/><circle class="piece-body" cx="40" cy="15" r="5"/><circle class="piece-body" cx="60" cy="15" r="5"/><circle class="piece-body" cx="78" cy="22" r="5"/><path class="piece-body" d="m22 28 11 33h34l11-33-18 19-10-25-10 25Z"/><path class="piece-body" d="M31 62h38l5 11 7 8H19l7-8Z"/><path class="piece-line" d="M27 72h46M20 81h60"/>',
    k:'<path class="piece-body" d="M46 11h8v10h10v8H54v11c10 3 16 11 15 21l7 12 6 8H18l6-8 7-12c-1-10 5-18 15-21V29H36v-8h10Z"/><path class="piece-line" d="M31 61h38M24 73h52M18 81h64"/>'
  };
  return `<svg class="piece-2d ${color==='w'?'white':'black'}" viewBox="0 0 100 100" aria-hidden="true"><g>${shapes[type]||shapes.p}</g></svg>`;
}

class ChessBoard2D {
  constructor(container){
    this.container=container;this.element=$('#board-2d',container);this.fen=new Chess().fen();this.viewColor='white';this.selected=null;this.destinations=[];this.lastMove='';this.checkSquare='';this.resultEffect=null;
    this.element.addEventListener('click',event=>{const square=event.target.closest('.square-2d');if(square)onSquare(square.dataset.square)});
  }
  orient(color='white'){this.viewColor=color;this.render()}
  load(fen){this.fen=fen;this.render()}
  commitMove(uci,fen){this.load(fen)}
  showPositionHighlights(lastMove='',checkSquare=''){this.lastMove=lastMove;this.checkSquare=checkSquare;this.render()}
  render(){
    const chess=new Chess(this.fen),files=this.viewColor==='black'?[...'hgfedcba']:[...'abcdefgh'],ranks=this.viewColor==='black'?[1,2,3,4,5,6,7,8]:[8,7,6,5,4,3,2,1];let html='';
    for(const rank of ranks)for(const file of files){const square=`${file}${rank}`,piece=chess.get(square),dark=(file.charCodeAt(0)-97+rank)%2===1,isEdgeFile=file===files[0],isEdgeRank=rank===ranks.at(-1),classes=['square-2d',dark?'dark':'light'];if(this.lastMove&&square===this.lastMove.slice(0,2))classes.push('last-from');if(this.lastMove&&square===this.lastMove.slice(2,4))classes.push('last-to');if(square===this.checkSquare)classes.push('in-check');if(square===this.selected)classes.push('selected');if(this.destinations.includes(square))classes.push(piece?'capture':'legal');const fallen=piece?.type==='k'&&piece.color===this.resultEffect?.loserColor;html+=`<button type="button" class="${classes.join(' ')}" data-square="${square}" aria-label="${square}">${piece?pieceSvg(piece.type,piece.color).replace('piece-2d ',`piece-2d${fallen?' result-loser':''} `):''}${isEdgeFile?`<small class="coord-2d coord-rank">${rank}</small>`:''}${isEdgeRank?`<small class="coord-2d coord-file">${file}</small>`:''}</button>`}
    this.element.innerHTML=html;
  }
  showMoves(selected,destinations=[]){this.selected=selected;this.destinations=destinations;this.render()}
  clearMarkers(){this.selected=null;this.destinations=[];this.render()}
  async animateMove(uci){
    const from=this.element.querySelector(`[data-square="${uci.slice(0,2)}"]`),to=this.element.querySelector(`[data-square="${uci.slice(2,4)}"]`),piece=from?.querySelector('.piece-2d');if(!from||!to||!piece)return;
    const a=piece.getBoundingClientRect(),b=to.getBoundingClientRect(),clone=piece.cloneNode(true);clone.classList.add('floating-piece-2d');clone.style.left=`${a.left}px`;clone.style.top=`${a.top}px`;clone.style.width=`${a.width}px`;clone.style.height=`${a.height}px`;document.body.append(clone);piece.style.visibility='hidden';
    requestAnimationFrame(()=>clone.style.transform=`translate(${b.left-a.left+(b.width-a.width)/2}px,${b.top-a.top+(b.height-a.height)/2}px)`);await sleep(82);clone.remove();piece.style.visibility='';
  }
  finishEffect(kind,loserColor=''){this.resultEffect={kind,loserColor};this.render()}
}

function checkedKingSquare(chess){
  if(!chess?.isCheck?.())return '';const checkedColor=chess.turn();
  for(const row of chess.board())for(const piece of row)if(piece?.type==='k'&&piece.color===checkedColor)return piece.square;
  return '';
}
function historyPosition(ply){
  const chess=new Chess(),moves=state.game?.move_history||[],safePly=Math.max(0,Math.min(ply,moves.length));
  for(let index=0;index<safePly;index++){try{chess.move(moveObject(moves[index].uci))}catch{break}}
  return {chess,ply:safePly,lastMove:safePly?moves[safePly-1]?.uci||'':''};
}
function showPositionHighlights(chess=state.chess,lastMove=''){
  state.board?.showPositionHighlights?.(lastMove,checkedKingSquare(chess));
}
function renderHistoryControls(){
  if(!state.game)return;const total=state.game.move_history?.length||0,viewing=state.historyPly===null?total:state.historyPly,isLive=state.historyPly===null;
  $('#history-back').disabled=viewing<=0;$('#history-forward').disabled=isLive||viewing>=total;$('#history-live').classList.toggle('live',isLive);$('#history-live span').textContent=isLive?'LIVE':`${viewing}/${total}`;$('#board-stage').classList.toggle('history-mode',!isLive);
  $$('.move-jump').forEach(button=>button.classList.toggle('current',!isLive&&Number(button.dataset.ply)===viewing));
  if(!isLive)$('#turn-banner').textContent=`TARIX · ${viewing}/${total}`;
}
function renderHistoryPosition(){
  if(state.historyPly===null||!state.game)return;const position=historyPosition(state.historyPly);state.historyPly=position.ply;state.board.load(position.chess.fen());state.board.clearMarkers();showPositionHighlights(position.chess,position.lastMove);renderHistoryControls();
}
function setHistoryPly(ply){
  if(!state.game||state.replaying||state.moving)return;const total=state.game.move_history?.length||0;
  state.selected=null;state.legal=[];state.premove=null;$('#premove-banner').classList.add('hidden');
  if(ply>=total){state.historyPly=null;state.board.load(state.game.fen);state.board.clearMarkers();showPositionHighlights(state.chess,state.game.move_history?.at(-1)?.uci||'');renderGame();return}
  state.historyPly=Math.max(0,ply);renderHistoryPosition();
}
function stepHistory(delta){const total=state.game?.move_history?.length||0,current=state.historyPly===null?total:state.historyPly;setHistoryPly(current+delta)}

function setBoardMode(mode,{render=true,notify=false}={}){
  mode=mode==='2d'?'2d':'3d';state.boardMode=mode;try{localStorage.setItem('zamin-board-mode',mode)}catch{}
  $$('.board-mode-options button').forEach(button=>button.classList.toggle('active',button.dataset.boardMode===mode));
  if($('#mode-toggle'))$('#mode-toggle').textContent=mode.toUpperCase();
  if(!render||!state.game)return;
  const stage=$('#board-stage');stage.classList.toggle('mode-2d',mode==='2d');
  if(mode==='2d'){state.board2d||=new ChessBoard2D(stage);state.board=state.board2d;if(state.board3d)state.board3d.active=false}
  else{state.board3d||=new ChessArena3D(stage);state.board3d.active=true;state.board=state.board3d}
  state.board.orient(state.game.my_color);state.selected=null;state.legal=[];
  if(state.historyPly===null){state.board.load(state.game.fen);showPositionHighlights(state.chess,state.game.move_history?.at(-1)?.uci||'')}else renderHistoryPosition();
  if(!['waiting','active'].includes(state.game.status)&&state.resultPresented)applyBoardResultEffect(state.game);
  if(notify)toast(`${mode.toUpperCase()} ko‘rinish yoqildi`,'good');
}

function startHero() {
  state.heroArena=new ChessArena3D($('#hero-stage'),{interactive:false,hero:true});state.heroArena.load(new Chess().fen());
  state.heroArena.root.rotation.y=-.28;
}

async function initialize() {
  try {
    state.config=await api('/api/config');
    const launchFragment=new URLSearchParams(location.hash.slice(1));
    const launchQuery=new URLSearchParams(location.search);
    const telegramInitData=tg?.initData||launchFragment.get('tgWebAppData')||launchQuery.get('tgWebAppData')||'';
    const watchCode=(launchQuery.get('watch')||'').trim().toUpperCase();
    if(watchCode){
      state.spectator=true;state.user={id:'spectator'};bindUI();setBoardMode(state.boardMode,{render:false});
      const watched=await api(`/api/watch/${encodeURIComponent(watchCode)}`);$('#app').classList.remove('hidden');$('#lobby').classList.add('hidden');$('#boot').classList.add('out');setTimeout(()=>$('#boot')?.remove(),450);await enterGame(watched.game);return;
    }
    const launchTicket=launchQuery.get('ticket')||launchFragment.get('ticket')||'';
    const fragmentStartParam=launchQuery.get('startapp')||launchFragment.get('startapp')||'';
    let session=null;
    if(!telegramInitData&&!launchTicket&&storedValue(SESSION_STORAGE_KEY)){
      state.token=storedValue(SESSION_STORAGE_KEY);
      try{session=await api('/api/session/restore')}catch{state.token='';storeValue(SESSION_STORAGE_KEY,'')}
    }
    if(!session){
      state.token='';session=await api('/api/session',{method:'POST',body:JSON.stringify({init_data:telegramInitData,launch_ticket:launchTicket})});
    }
    // Remove the short-lived credential from the address after it is accepted.
    // The longer API session token remains only in this page's memory.
    if(launchTicket) history.replaceState(null,'',location.pathname);
    Object.assign(state,{token:session.token||state.token,user:session.user,profile:session.profile});storeValue(SESSION_STORAGE_KEY,state.token);
    state.theme=session.profile?.equipped_theme||storedValue('zamin-theme')||'registan';state.performanceMode=session.profile?.performance_mode||storedValue('zamin-performance')||'auto';
    state.boardPalette=session.profile?.board_palette||storedValue('zamin-board-palette')||'pro_green';state.pieceStyle=session.profile?.piece_style||storedValue('zamin-piece-style')||'staunton';state.boardShape=session.profile?.board_shape||storedValue('zamin-board-shape')||'tournament';
    applyAppearance();renderProfile(); startHero(); bindUI(); setBoardMode(state.boardMode,{render:false});
    $('#app').classList.remove('hidden'); await sleep(350); $('#boot').classList.add('out'); setTimeout(()=>$('#boot').remove(),700);
    if(!session.registered) openModal('#onboarding'); else await loadRecent();
    const startParam=tg?.initDataUnsafe?.start_param||fragmentStartParam||new URLSearchParams(location.search).get('startapp');
    if(startParam?.startsWith('join_')) {
      if(session.registered) await joinChallenge(startParam.slice(5));
      else state.pendingChallenge=startParam.slice(5);
    }else if(session.registered)await restoreActiveGame();
  } catch(error) {
    $('#boot').classList.add('out'); $('#app').classList.remove('hidden');
    setTimeout(()=>$('#boot')?.remove(),500); toast(error.message,'error');
    const directUrl=state.config?.direct_app_url||'';
    document.body.insertAdjacentHTML('beforeend',`<div class="modal-backdrop"><div class="modal"><div class="modal-symbol">♞</div><h2>Telegram Mini App orqali oching</h2><p>${escapeHtml(error.message)}</p>${directUrl?'<button id="direct-app-open" class="primary-btn wide">MINI APP’NI TO‘G‘RI OCHISH →</button>':''}<small>BotFather’dagi Main Mini App short name va URL to‘g‘ri sozlangan bo‘lishi kerak. Yoki botga /start yuborib ARENANI OCHISH tugmasini bosing.</small></div></div>`);
    if(directUrl)$('#direct-app-open').onclick=()=>{if(tg?.openTelegramLink)tg.openTelegramLink(directUrl);else window.open(directUrl,'_self')};
  }
}

function bindUI() {
  $$('[data-open]').forEach(btn=>btn.onclick=()=>showNewGame(btn.dataset.open));
  $$('.modal-close').forEach(btn=>btn.onclick=()=>closeModal(btn));
  $$('.modal-backdrop').forEach(back=>back.addEventListener('click',e=>{if(e.target===back&&back.id!=='onboarding')back.classList.add('hidden')}));
  $$('.ai-levels button').forEach(btn=>btn.onclick=()=>{$$('.ai-levels button').forEach(x=>x.classList.remove('active'));btn.classList.add('active');state.aiLevel=+btn.dataset.level});
  $$('.variant-options button').forEach(btn=>btn.onclick=()=>{$$('.variant-options button').forEach(x=>x.classList.remove('active'));btn.classList.add('active');state.variant=btn.dataset.variant});
  $$('.time-grid button').forEach(btn=>btn.onclick=()=>{$$('.time-grid button').forEach(x=>x.classList.remove('active'));btn.classList.add('active');$('#correspondence-mode').classList.remove('active');state.time=+btn.dataset.time;state.increment=+btn.dataset.inc});
  $$('.series-options button').forEach(btn=>btn.onclick=()=>{$$('.series-options button').forEach(x=>x.classList.remove('active'));btn.classList.add('active');state.seriesBestOf=+btn.dataset.series});
  $('#casual-mode').onchange=()=>state.casual=$('#casual-mode').checked;
  $('#correspondence-mode').onclick=()=>{const active=state.time===86400;state.time=active?600:86400;state.increment=active?3:0;state.casual=!active;$('#casual-mode').checked=state.casual;$('#correspondence-mode').classList.toggle('active',!active);$$('.time-grid button').forEach(button=>button.classList.toggle('active',active&&button.dataset.time==='600'));toast(active?'Oddiy vaqt qaytdi':'Har yurish uchun 24 soat · Telegram eslatadi','good')};
  $$('.board-mode-options button').forEach(btn=>btn.onclick=()=>setBoardMode(btn.dataset.boardMode,{render:!!state.game}));
  $('#create-game').onclick=createGame;
  $('#profile-form').onsubmit=saveProfile;
  $('#join-form').onsubmit=e=>{e.preventDefault();joinChallenge($('#join-code').value)};
  $('#refresh-games').onclick=loadRecent;
  $('#share-challenge').onclick=shareChallenge; $('#copy-challenge').onclick=copyChallenge;
  $('#leave-game').onclick=leaveGame;$('#result-home').onclick=leaveGame;$('#result-dismiss').onclick=()=>$('#result-modal').classList.add('hidden');
  $('#mode-toggle').onclick=()=>setBoardMode(state.boardMode==='2d'?'3d':'2d',{render:true,notify:true});
  $('#appearance-toggle').onclick=()=>{renderArmory();openModal('#armory-modal')};
  $('#view-toggle').onclick=()=>state.board?.orient(state.board.viewColor==='white'?'black':'white');
  $('#panel-toggle').onclick=()=>$('.game-panel').classList.toggle('open');
  $$('[data-panel-open]').forEach(btn=>btn.onclick=()=>$('.game-panel').classList.add('open'));
  $$('[data-panel-close]').forEach(btn=>btn.onclick=()=>$('.game-panel').classList.remove('open'));
  $('#camera-tab').onclick=()=>{state.board?.orient(state.board.viewColor==='white'?'black':'white');if(innerWidth<=900)$('.game-panel').classList.remove('open')};
  $$('[data-sound-toggle]').forEach(btn=>btn.onclick=()=>{state.sound=!state.sound;$$('[data-sound-toggle] b').forEach(icon=>icon.textContent=state.sound?'◖':'×');if(state.sound)audio.move();toast(state.sound?'Ovoz yoqildi':'Ovoz o‘chirildi')});
  $$('[data-action]').forEach(btn=>btn.onclick=()=>gameAction(btn.dataset.action));
  $$('[data-reaction]').forEach(btn=>btn.onclick=()=>sendReaction(btn.dataset.reaction));
  $$('[data-feature]').forEach(btn=>btn.onclick=()=>openFeature(btn.dataset.feature));
  $$('.theme-grid button').forEach(btn=>btn.onclick=()=>saveAppearance({theme:btn.dataset.theme}));
  $$('[data-board-palette]').forEach(btn=>btn.onclick=()=>saveAppearance({boardPalette:btn.dataset.boardPalette}));
  $$('[data-piece-style]').forEach(btn=>btn.onclick=()=>saveAppearance({pieceStyle:btn.dataset.pieceStyle}));
  $$('[data-board-shape]').forEach(btn=>btn.onclick=()=>saveAppearance({boardShape:btn.dataset.boardShape}));
  $('#performance-mode').onchange=()=>saveAppearance({performanceMode:$('#performance-mode').value});
  $('#puzzle-hint').onclick=()=>toast(state.puzzle?.hint||'Markazni tekshiring');
  $('#create-clan').onclick=createClan;$('#create-tournament').onclick=createTournament;
  $('#join-clan').onsubmit=joinClan;
  $('#review-game').onclick=showGameReview;$('#replay-game').onclick=playCinematicReplay;$('#rematch-game').onclick=createRematch;
  $('#share-result').onclick=shareResult;
  $('#share-spectator').onclick=shareSpectator;
  $('#history-back').onclick=()=>stepHistory(-1);$('#history-forward').onclick=()=>stepHistory(1);$('#history-live').onclick=()=>setHistoryPly(state.game?.move_history?.length||0);
  document.addEventListener('pointerdown',()=>audio.wake(),{once:true});
  document.addEventListener('visibilitychange',()=>{
    const visible=!document.hidden;
    if(state.board3d)state.board3d.active=visible&&state.boardMode==='3d'&&Boolean(state.game);
    if(state.heroArena)state.heroArena.active=visible&&!state.game;
  });
}

function escapeHtml(text=''){const d=document.createElement('div');d.textContent=text;return d.innerHTML}
function renderProfile(){
  const name=state.profile?.full_name||[state.user?.first_name,state.user?.last_name].filter(Boolean).join(' ')||'O‘yinchi';
  $('#profile-name').textContent=name;$('#self-name').textContent=name;$('#profile-initial').textContent=name[0].toUpperCase();
  const p=state.profile||{},xp=Number(p.army_xp||0),level=Math.floor(xp/120)+1;$('#profile-rating').textContent=p.rating||1200;$('#games-count').textContent=p.games_played||0;$('#wins-count').textContent=p.wins||0;$('#losses-count').textContent=p.losses||0;$('#draws-count').textContent=p.draws||0;$('#rank-needed').textContent=Math.max(0,1400-(p.rating||1200));$('#army-level').textContent=level;$('#puzzle-streak').textContent=`${p.puzzle_streak||0} kunlik seriya`;$('#xp-progress').style.width=`${xp%120/1.2}%`;
}

function applyAppearance(){
  const body=document.body,groups=['theme-registan','theme-cyber','theme-ice','theme-volcano','performance-auto','performance-quality','performance-battery','palette-pro_green','palette-walnut','palette-slate','palette-contrast','pieces-staunton','pieces-modern','pieces-royal','shape-tournament','shape-soft','shape-floating'];
  body.classList.remove(...groups);body.classList.add(`theme-${state.theme}`,`performance-${state.performanceMode}`,`palette-${state.boardPalette}`,`pieces-${state.pieceStyle}`,`shape-${state.boardShape}`);
  $$('[data-theme]').forEach(button=>button.classList.toggle('active',button.dataset.theme===state.theme));$$('[data-board-palette]').forEach(button=>button.classList.toggle('active',button.dataset.boardPalette===state.boardPalette));$$('[data-piece-style]').forEach(button=>button.classList.toggle('active',button.dataset.pieceStyle===state.pieceStyle));$$('[data-board-shape]').forEach(button=>button.classList.toggle('active',button.dataset.boardShape===state.boardShape));if($('#performance-mode'))$('#performance-mode').value=state.performanceMode;
}
async function saveAppearance(patch={}){
  Object.assign(state,patch);storeValue('zamin-theme',state.theme);storeValue('zamin-performance',state.performanceMode);storeValue('zamin-board-palette',state.boardPalette);storeValue('zamin-piece-style',state.pieceStyle);storeValue('zamin-board-shape',state.boardShape);applyAppearance();
  if(state.board2d)state.board2d.render();if(state.board3d){state.board3d.dispose();state.board3d=null;if(state.game&&state.boardMode==='3d')setBoardMode('3d',{render:true})}if(state.heroArena){state.heroArena.dispose();state.heroArena=null;if(!state.game)startHero()}
  try{const data=await api('/api/preferences',{method:'POST',body:JSON.stringify({theme:state.theme,performance_mode:state.performanceMode,board_palette:state.boardPalette,piece_style:state.pieceStyle,board_shape:state.boardShape})});state.profile=data.profile;renderProfile();toast('Ko‘rinish saqlandi','good')}catch(e){toast(`${e.message}. Tanlov ushbu qurilmada saqlandi.`,'error')}
}

function openFeature(feature){if(feature==='puzzle')openDailyPuzzle();else if(feature==='armory'){renderArmory();openModal('#armory-modal')}else if(feature==='social'){openModal('#social-modal');loadSocial()}}
function renderArmory(){const xp=Number(state.profile?.army_xp||0),level=Math.floor(xp/120)+1,names=['Bronza qo‘shin','Kumush soqchilar','Oltin legion','Zamin elitalari','Afsonaviy saltanat'];$('#evolution-name').textContent=names[Math.min(names.length-1,Math.floor((level-1)/2))];$('#evolution-xp').textContent=`${xp} XP · ${level}-daraja`;applyAppearance()}

function dailyPuzzle(){const day=Math.floor(Date.now()/86400000);return PUZZLES[day%PUZZLES.length]}
function puzzleMarkup(chess,selected=''){
  let html='';
  for(const rank of [8,7,6,5,4,3,2,1])for(const file of 'abcdefgh'){const square=`${file}${rank}`,piece=chess.get(square),dark=(file.charCodeAt(0)-97+rank)%2===1;html+=`<button type="button" class="square-2d ${dark?'dark':'light'} ${selected===square?'selected':''}" data-puzzle-square="${square}">${piece?pieceSvg(piece.type,piece.color):''}</button>`}return html;
}
function openDailyPuzzle(){state.puzzle={...dailyPuzzle(),selected:'',chess:new Chess(dailyPuzzle().fen),completed:false};state.puzzleStartedAt=Date.now();$('#puzzle-title').textContent=state.puzzle.title;$('#puzzle-task').textContent='Oqlar yuradi. Eng kuchli yurishni toping.';$('#puzzle-modal-streak').textContent=state.profile?.puzzle_streak||0;renderPuzzle();openModal('#puzzle-modal')}
function renderPuzzle(){$('#puzzle-board').innerHTML=puzzleMarkup(state.puzzle.chess,state.puzzle.selected);$$('[data-puzzle-square]').forEach(square=>square.onclick=()=>playPuzzleSquare(square.dataset.puzzleSquare))}
async function playPuzzleSquare(square){if(!state.puzzle||state.puzzle.completed)return;const piece=state.puzzle.chess.get(square);if(!state.puzzle.selected){if(piece?.color!=='w')return;state.puzzle.selected=square;renderPuzzle();return}const uci=state.puzzle.selected+square;if(uci!==state.puzzle.solution){state.puzzle.selected='';renderPuzzle();tg?.HapticFeedback?.notificationOccurred?.('error');toast('Bu yurish hal qiluvchi emas. Qayta urinib ko‘ring.','error');return}state.puzzle.chess.move({from:uci.slice(0,2),to:uci.slice(2,4)});state.puzzle.completed=true;renderPuzzle();audio.victory();tg?.HapticFeedback?.notificationOccurred?.('success');$('#puzzle-task').textContent='Topildi! Ekspeditsiya mukofoti hisoblandi.';try{const data=await api('/api/puzzles/complete',{method:'POST',body:JSON.stringify({puzzle_id:state.puzzle.id,elapsed_ms:Date.now()-state.puzzleStartedAt})});state.profile=data.profile;renderProfile();$('#puzzle-modal-streak').textContent=data.profile.puzzle_streak||0;toast(data.already_completed?'Bugungi mukofot avval olingan':`+${data.rating_gain} puzzle reyting · +${data.xp_gain} XP`,'good')}catch(e){toast(e.message,'error')}}

async function loadSocial(){
  const zone=$('#clan-zone'),list=$('#tournament-list'),leaderboard=$('#clan-leaderboard');zone.innerHTML='<p>Ma’lumotlar yuklanmoqda...</p>';list.innerHTML='';leaderboard.innerHTML='';
  try{
    const data=await api('/api/social');
    zone.innerHTML=data.clan?`<b>${escapeHtml(data.clan.clan.name)}</b><p>Kod: ${data.clan.clan.code} · ${data.clan.member_count} jangchi · ${data.clan.clan.xp||0} XP</p>`:'<b>Siz hali jamoada emassiz</b><p>Yangi clan yarating yoki 7 belgili kod bilan qo‘shiling.</p>';
    leaderboard.innerHTML=(data.clan_leaderboard||[]).map((clan,index)=>`<div><b>${index+1}</b><span>${escapeHtml(clan.name)}</span><em>${clan.xp||0} XP</em></div>`).join('')||'<p>Hali jamoalar yo‘q.</p>';
    list.innerHTML=data.tournaments.length?data.tournaments.map(t=>{
      const owner=t.owner_id===String(state.user.id),registration=t.status==='registration',hasGame=Boolean(t.my_game);
      const label=hasGame?'JANGNI OCHISH':registration?(owner?'BOSHLASH':t.joined?'QO‘SHILGAN':'QO‘SHILISH'):t.status==='finished'?'YAKUNLANGAN':'JANG BOSHLANGAN';
      const podium=(t.standings||[]).map((entry,index)=>`${index+1}. ${escapeHtml(entry.display_name)} · ${Number(entry.score).toFixed(1)}`).join(' &nbsp; ');
      return `<div class="tournament-item"><div><b>${escapeHtml(t.name)}</b><span>${variantLabel(t.variant)} · ${t.time_control/60}+${t.increment} · ${t.player_count}/${t.max_players}${t.clan_war?' · CLAN WAR':''}</span>${podium?`<small>${podium}</small>`:''}</div><button data-tournament="${t.id}" data-game="${hasGame?t.my_game.id:''}" data-owner="${owner}" data-status="${t.status}" ${!hasGame&&(!registration||(!owner&&t.joined))?'disabled':''}>${label}</button></div>`
    }).join(''):'<div class="moves-empty">Hozircha ochiq turnir yo‘q.</div>';
    $$('[data-tournament]').forEach(button=>button.onclick=async()=>{if(button.dataset.game){const data=await api(`/api/games/${button.dataset.game}`);closeModal($('#social-modal'));await enterGame(data.game)}else if(button.dataset.status==='registration')button.dataset.owner==='true'?startTournament(button.dataset.tournament):joinTournament(button.dataset.tournament)});
  }catch(e){zone.innerHTML=`<p>${escapeHtml(e.message)}</p>`}
}
async function createClan(){const name=$('#social-name').value.trim();if(name.length<3)return toast('Jamoa nomini yozing','error');try{const data=await api('/api/clans',{method:'POST',body:JSON.stringify({name})});toast(`${data.clan.name} jamoasi yaratildi`,'good');loadSocial()}catch(e){toast(e.message,'error')}}
async function joinClan(event){event.preventDefault();const code=$('#clan-code').value.trim();if(!code)return;try{const data=await api(`/api/clans/${encodeURIComponent(code)}/join`,{method:'POST',body:'{}'});toast(`${data.clan.name} jamoasiga qo‘shildingiz`,'good');loadSocial()}catch(e){toast(e.message,'error')}}
async function createTournament(){const name=$('#social-name').value.trim();if(name.length<3)return toast('Turnir nomini yozing','error');try{await api('/api/tournaments',{method:'POST',body:JSON.stringify({name,max_players:8,variant:state.variant,time_control:180,increment:0,clan_war:true})});toast('Turnir ro‘yxati ochildi','good');loadSocial()}catch(e){toast(e.message,'error')}}
async function joinTournament(id){try{await api(`/api/tournaments/${id}/join`,{method:'POST',body:'{}'});toast('Turnirga qo‘shildingiz','good');loadSocial()}catch(e){toast(e.message,'error')}}
async function startTournament(id){try{const data=await api(`/api/tournaments/${id}/start`,{method:'POST',body:'{}'});toast(`${data.games_created} ta jang boshlandi`,'good');if(data.games?.[0]){closeModal($('#social-modal'));await enterGame(data.games[0])}else loadSocial()}catch(e){toast(e.message,'error')}}

async function saveProfile(event){
  event.preventDefault();const btn=$('button[type="submit"]',event.currentTarget);setLoading(btn,true);
  try{const data=await api('/api/profile',{method:'POST',body:JSON.stringify({full_name:$('#full-name').value,phone:$('#phone').value})});state.profile=data.profile;renderProfile();closeModal(btn);toast('Arena pasporti tayyor','good');await loadRecent();if(state.pendingChallenge){const code=state.pendingChallenge;state.pendingChallenge='';await joinChallenge(code)}}
  catch(e){toast(e.message,'error')}finally{setLoading(btn,false)}
}

function showNewGame(mode,opponentId=''){state.mode=mode;state.opponentId=opponentId;if(mode==='ai'&&state.time>=86400){state.time=600;state.increment=3;state.casual=false;$('#casual-mode').checked=false;$('#correspondence-mode').classList.remove('active');$$('.time-grid button').forEach(button=>button.classList.toggle('active',button.dataset.time==='600'))}$('#new-game-title').textContent=mode==='ai'?'Sun’iy aql bilan jang':opponentId?'Raqibni qayta chorlash':'Do‘stni chorlash';$('#ai-options').classList.toggle('hidden',mode!=='ai');$('#friend-options').classList.toggle('hidden',mode==='ai');setBoardMode(state.boardMode,{render:false});openModal('#new-game-modal')}

async function createGame(){
  const btn=$('#create-game');setLoading(btn,true);
  try{const data=await api('/api/games',{method:'POST',body:JSON.stringify({mode:state.mode,variant:state.variant,time_control:state.time,increment:state.increment,ai_level:state.aiLevel,casual:state.casual,series_best_of:state.seriesBestOf,opponent_id:state.opponentId||null})});closeModal(btn);state.opponentId='';state.shareUrl=data.share_url;storeValue(ACTIVE_GAME_KEY,data.game.id);if(state.mode==='friend'){state.game=data.game;$('#challenge-code').textContent=data.game.code;openModal('#challenge-modal');await subscribe(data.game.id)}else await enterGame(data.game)}
  catch(e){toast(e.message,'error')}finally{setLoading(btn,false)}
}

function challengeUrl(code){return state.config?.bot_username?`https://t.me/${state.config.bot_username}?start=join_${code}`:`${location.origin}/?startapp=join_${code}`}
async function restoreActiveGame(){
  const gameId=storedValue(ACTIVE_GAME_KEY);if(!gameId||state.game)return;
  try{const data=await api(`/api/games/${gameId}`),game=data.game;if(!['waiting','active'].includes(game.status)){storeValue(ACTIVE_GAME_KEY,'');return}if(game.status==='waiting'){state.game=game;state.shareUrl=challengeUrl(game.code);$('#challenge-code').textContent=game.code;openModal('#challenge-modal');await subscribe(game.id)}else await enterGame(game)}catch{storeValue(ACTIVE_GAME_KEY,'')}
}

async function joinChallenge(raw){
  const challenge=(raw||'').trim().toUpperCase();if(!challenge)return;
  try{const data=await api(`/api/challenges/${encodeURIComponent(challenge)}/join`,{method:'POST',body:'{}'});closeModal($('#challenge-modal'));toast('Challenge qabul qilindi','good');await enterGame(data.game)}catch(e){toast(e.message,'error')}
}

function shareChallenge(){
  const format=state.game?.correspondence?'24 soat/yurish':`${Math.round((state.game?.time_control||600)/60)}+${state.game?.increment||0}`;const text=`⚔️ Men sizni ZAMIN Chess BO${state.game?.series_best_of||1} jangiga chorlayman!\n${variantLabel(state.game?.variant)} · ${format}${state.game?.casual?' · Casual':''}\n\nChallenge kodi: ${state.game?.code}\nTaxtada ko‘rishamiz.`;
  const url=`https://t.me/share/url?url=${encodeURIComponent(state.shareUrl)}&text=${encodeURIComponent(text)}`;
  storeValue(ACTIVE_GAME_KEY,state.game?.id||'');navigator.clipboard?.writeText(state.shareUrl).catch(()=>{});toast('Jang saqlandi — qaytganingizda shu taxta ochiladi','good');
  if(navigator.share)navigator.share({title:'ZAMIN Chess challenge',text,url:state.shareUrl}).catch(()=>tg?.openTelegramLink?tg.openTelegramLink(url):window.open(url,'_blank'));
  else if(tg?.openTelegramLink)tg.openTelegramLink(url);else window.open(url,'_blank');
}
async function copyChallenge(){try{await navigator.clipboard.writeText(state.shareUrl);toast('Havola nusxalandi','good')}catch{toast(state.shareUrl)}}

async function subscribe(gameId){
  if(state.socketPing){clearInterval(state.socketPing);state.socketPing=null}if(state.socket){state.socket.onclose=null;state.socket.close()}
  const protocol=location.protocol==='https:'?'wss:':'ws:';
  const socket=new WebSocket(`${protocol}//${location.host}/ws/games/${gameId}`);
  state.socket=socket;
  socket.onopen=()=>{socket.send(JSON.stringify(state.spectator?{watch_code:state.game.code}:{token:state.token}));state.socketPing=setInterval(()=>{if(socket.readyState===WebSocket.OPEN)socket.send('ping')},25000);$('#reconnect-banner').classList.add('hidden')};
  socket.onmessage=event=>{try{state.realtimeLive=true;$('#live-indicator').classList.add('live');$('#reconnect-banner').classList.add('hidden');const payload=JSON.parse(event.data);if(payload.presence){state.presence=payload.presence;$('#presence-count').textContent=`${payload.presence.players}/2 · ◉ ${payload.presence.spectators}`};if(payload.reaction)showReaction(payload.reaction);const game=payload.game;if(!game)return;if($('#challenge-modal:not(.hidden)')&&game.status==='active'){closeModal($('#challenge-modal'));enterGame(game)}else updateGame(game)}catch{}};
  socket.onerror=()=>{state.realtimeLive=false;$('#live-indicator').classList.remove('live');if(state.game)$('#reconnect-banner').classList.remove('hidden')};
  socket.onclose=()=>{if(state.socketPing){clearInterval(state.socketPing);state.socketPing=null}state.realtimeLive=false;$('#live-indicator').classList.remove('live');if(state.game?.id===gameId){$('#reconnect-banner').classList.remove('hidden');setTimeout(()=>subscribe(gameId),1800)}};
}

function showReaction(reaction){const burst=$('#reaction-burst');burst.innerHTML=`<b>${escapeHtml(reaction.emoji)}</b><span>${escapeHtml(reaction.name||'O‘yinchi')}</span>`;burst.classList.remove('hidden');burst.style.animation='none';void burst.offsetWidth;burst.style.animation='';setTimeout(()=>burst.classList.add('hidden'),2100);tg?.HapticFeedback?.impactOccurred?.('light')}
async function sendReaction(emoji){if(!state.game)return;if(state.socket?.readyState===WebSocket.OPEN){state.socket.send(JSON.stringify({reaction:emoji}));return}if(state.spectator)return;try{await api(`/api/games/${state.game.id}/reaction`,{method:'POST',body:JSON.stringify({emoji})})}catch(e){if(!e.message.includes('biroz'))toast(e.message,'error')}}

async function enterGame(game){
  state.game=game;state.chess=new Chess(game.fen);state.selected=null;state.premove=null;state.replaying=false;state.historyPly=null;state.resultSynced=false;state.resultPresented=false;state.timeoutClaimed=false;
  if(state.board2d)state.board2d.resultEffect=null;
  if(['waiting','active'].includes(game.status))storeValue(ACTIVE_GAME_KEY,game.id);else storeValue(ACTIVE_GAME_KEY,'');
  // Lobby sahnasini GPU xotirasida ushlab turmaymiz: o'yinda faqat bitta WebGL arena qoladi.
  if(state.heroArena){state.heroArena.dispose();state.heroArena=null}
  $('.game-panel').classList.remove('open');
  $('#lobby').classList.add('hidden');$('#game').classList.remove('hidden');$('#game-code').textContent=game.code;
  $('#result-modal').classList.add('hidden');$('#board-stage').classList.remove('result-win','result-loss','result-draw');
  $('#premove-banner').classList.add('hidden');$('#reconnect-banner').classList.add('hidden');
  $('#spectator-banner').classList.toggle('hidden',!state.spectator);$$('[data-action],#rematch-game').forEach(button=>button.disabled=state.spectator);
  $('.player-strip.opponent small').textContent=state.spectator?'QORA':'RAQIB';$('.player-strip.self small').textContent=state.spectator?'OQ':'SIZ';
  $('#opponent-name').textContent=state.spectator?(game.black_name||'Qora'):(game.my_color==='white'?(game.black_name||'Raqib kutilmoqda'):(game.white_name||'Raqib'));if(state.spectator)$('#self-name').textContent=game.white_name||'Oq';
  setBoardMode(state.boardMode,{render:true});
  renderGame();await subscribe(game.id);maybeAiMove();
}

async function updateGame(game){
  if(!state.game||game.id!==state.game.id)return;
  if(game.version<=state.game.version)return;
  const old=state.game,last=game.move_history?.at(-1),moveDelta=(game.move_history?.length||0)-(old.move_history?.length||0),hasNewMove=moveDelta>0;
  state.game=game;state.timeoutClaimed=false;
  if(state.historyPly!==null){state.chess=new Chess(game.fen);renderGame();if(hasNewMove){if(last?.san?.includes('+')||last?.san?.includes('#'))audio.check();else audio.move();toast('Yangi yurish keldi · LIVE tugmasi bilan qayting','good')}maybeAiMove();return}
  if(hasNewMove&&last){state.moving=true;if(moveDelta===1){await state.board.animateMove(last.uci,last.san.includes('x'));state.board.commitMove(last.uci,game.fen)}else state.board.load(game.fen);state.moving=false;if(last.san.includes('+')||last.san.includes('#'))audio.check()}
  else if(game.fen!==old.fen)state.board.load(game.fen);
  state.chess=new Chess(game.fen);showPositionHighlights(state.chess,last?.uci||'');renderGame();if(!state.spectator)tryExecutePremove();maybeAiMove();
}

function renderGame(){
  const g=state.game;if(!g)return;
  $('#game-code').textContent=g.code;$('#opponent-name').textContent=state.spectator?(g.black_name||'Qora'):(g.my_color==='white'?(g.black_name||'Raqib kutilmoqda'):(g.white_name||'Raqib'));if(state.spectator)$('#self-name').textContent=g.white_name||'Oq';
  const score=g.series_score||{},mineScore=state.spectator?(score.white||0):(score.mine||0),opponentScore=state.spectator?(score.black||0):(score.opponent||0);$('#series-score').textContent=`BO${g.series_best_of||1} · ${mineScore}:${opponentScore} · #${g.series_game_no||1}`;
  const mine=g.my_color,active=g.status==='active'&&g.turn===mine;
  $('#turn-banner').textContent=state.replaying?'KINEMATIK REPLAY':state.spectator?(g.status==='active'?(g.turn==='white'?'OQLAR YURADI':'QORALAR YURADI'):'JANG YAKUNLANDI'):g.status==='waiting'?'RAQIB KUTILMOQDA':g.status!=='active'?'JANG YAKUNLANDI':active?'SIZNING YURISHINGIZ':g.mode==='ai'&&g.turn==='black'?'AI O‘YLAYAPTI...':'RAQIB YURISHI';
  if(innerWidth<600)$('#turn-banner').textContent+=` · ${mineScore}:${opponentScore}`;
  $('#turn-banner').style.borderColor=active?'#b89152':'#40444c';
  const moves=g.move_history||[],list=$('#moves-list');
  if(!moves.length)list.innerHTML='<div class="moves-empty">Birinchi yurish tarixni boshlaydi.</div>';
  else{let html='';for(let i=0;i<moves.length;i+=2)html+=`<div class="move-row"><span>${i/2+1}.</span><button class="move-jump" data-ply="${i+1}">${escapeHtml(moves[i]?.san||'')}</button>${moves[i+1]?`<button class="move-jump" data-ply="${i+2}">${escapeHtml(moves[i+1].san||'')}</button>`:'<i></i>'}</div>`;list.innerHTML=html;$$('.move-jump',list).forEach(button=>button.onclick=()=>{setHistoryPly(Number(button.dataset.ply));if(innerWidth<=900)$('.game-panel').classList.remove('open')});if(state.historyPly===null)list.scrollTop=list.scrollHeight}
  const offer=g.draw_offer_by==='opponent';$('#draw-offer').classList.toggle('hidden',!offer);
  const takeback=g.takeback_by==='opponent';$('#takeback-offer').classList.toggle('hidden',!takeback);$('#takeback-button').classList.toggle('hidden',!g.casual);$('#takeback-button').disabled=state.spectator||g.status!=='active'||!(g.move_history||[]).length;
  $('#reaction-dock').classList.remove('hidden');
  $$('[data-action="offer_draw"],[data-action="resign"]').forEach(button=>button.disabled=state.spectator||g.status!=='active');
  if(!state.spectator&&!['waiting','active'].includes(g.status)&&!state.resultSynced){state.resultSynced=true;loadRecent()}
  if(!['waiting','active'].includes(g.status))storeValue(ACTIVE_GAME_KEY,'');
  if(!['waiting','active'].includes(g.status)&&!state.replaying&&!state.resultPresented&&!$('#review-modal:not(.hidden)'))showResult(g);
  renderHistoryControls();
}

function onSquare(square){
  const g=state.game;if(!g||state.spectator||state.replaying||state.historyPly!==null||g.status!=='active'||state.moving||state.aiThinking)return;if(g.turn!==g.my_color){handlePremove(square);return}
  const piece=state.chess.get(square),myColor=g.my_color[0];
  if(!state.selected){if(piece?.color===myColor)selectSquare(square);return}
  if(piece?.color===myColor){selectSquare(square);return}
  const candidate=state.legal.find(m=>m.to===square);if(candidate)submitMove(state.selected,square,candidate);else{state.selected=null;state.board.clearMarkers()}
}
function selectSquare(square){state.selectionMode='move';state.selected=square;state.legal=state.chess.moves({square,verbose:true});state.board.showMoves(square,state.legal.map(m=>m.to));tg?.HapticFeedback?.selectionChanged?.()}

function premovePosition(){const parts=state.game.fen.split(' ');parts[1]=state.game.my_color[0];parts[3]='-';try{return new Chess(parts.join(' '))}catch{return null}}
function handlePremove(square){
  const chess=premovePosition();if(!chess)return;const piece=chess.get(square),mine=state.game.my_color[0];
  if(state.premove&&[state.premove.from,state.premove.to].includes(square)){state.premove=null;state.selected=null;state.board.clearMarkers();$('#premove-banner').classList.add('hidden');toast('Oldindan yurish bekor qilindi');return}
  if(!state.selected||state.selectionMode!=='premove'){if(piece?.color!==mine)return;state.premove=null;$('#premove-banner').classList.add('hidden');state.selectionMode='premove';state.selected=square;state.legal=chess.moves({square,verbose:true});state.board.showMoves(square,state.legal.map(move=>move.to));return}
  if(piece?.color===mine){state.selected=square;state.legal=chess.moves({square,verbose:true});state.board.showMoves(square,state.legal.map(move=>move.to));return}
  const candidate=state.legal.find(move=>move.to===square);if(!candidate){state.selected=null;state.board.clearMarkers();return}
  state.premove={from:state.selected,to:square,promotion:candidate.promotion||'q'};state.selected=null;state.board.showMoves(state.premove.from,[state.premove.to]);$('#premove-banner').classList.remove('hidden');toast('Oldindan yurish belgilandi');
}
function tryExecutePremove(){
  if(!state.premove||state.game.turn!==state.game.my_color||state.game.status!=='active')return;const premove=state.premove,legal=state.chess.moves({square:premove.from,verbose:true}),candidate=legal.find(move=>move.to===premove.to);
  state.premove=null;$('#premove-banner').classList.add('hidden');state.board.clearMarkers();if(!candidate){toast('Oldindan yurish endi mumkin emas','error');return}setTimeout(()=>submitMove(premove.from,premove.to,{...candidate,promotion:premove.promotion}),35);
}

async function choosePromotion(){
  return new Promise(resolve=>{
    const back=document.createElement('div');back.className='modal-backdrop';back.innerHTML='<div class="modal"><span class="eyebrow">PROMOTION</span><h2>Donani tanlang</h2><div class="segmented"><button data-p="q">♛</button><button data-p="r">♜</button><button data-p="b">♝</button><button data-p="n">♞</button></div></div>';
    document.body.append(back);$$('[data-p]',back).forEach(b=>b.onclick=()=>{resolve(b.dataset.p);back.remove()});
  });
}
async function submitMove(from,to,moveInfo){
  let promotion=moveInfo.promotion||'';if(promotion&&state.chess.get(from)?.type==='p')promotion=await choosePromotion();
  const uci=from+to+promotion,snapshot=state.game,optimisticChess=new Chess(snapshot.fen),localMove=optimisticChess.move({from,to,promotion:promotion||undefined});if(!localMove)return;
  state.selected=null;state.board.clearMarkers();state.moving=true;
  const optimisticGame={...snapshot,fen:optimisticChess.fen(),turn:optimisticChess.turn()==='w'?'white':'black',last_move_at:new Date().toISOString(),move_history:[...(snapshot.move_history||[]),{uci,san:localMove.san,by:String(state.user.id),pending:true}]};
  state.game=optimisticGame;state.chess=optimisticChess;renderGame();tg?.HapticFeedback?.impactOccurred?.('light');
  const serverReply=api(`/api/games/${snapshot.id}/move`,{method:'POST',body:JSON.stringify({uci,expected_version:snapshot.version})});
  try{await state.board.animateMove(uci,!!localMove.captured);state.board.commitMove(uci,optimisticGame.fen);showPositionHighlights(optimisticChess,uci);if(localMove.san.includes('+')||localMove.san.includes('#'))audio.check();state.moving=false;const data=await serverReply;await updateGame(data.game)}
  catch(e){state.moving=false;state.game=snapshot;state.chess=new Chess(snapshot.fen);state.board.load(snapshot.fen);showPositionHighlights(state.chess,snapshot.move_history?.at(-1)?.uci||'');renderGame();toast(e.message,'error');try{const fresh=await api(`/api/games/${snapshot.id}`);if(fresh.game.version>snapshot.version)await updateGame(fresh.game)}catch{}}
}

function evaluate(chess){
  if(chess.isCheckmate())return chess.turn()==='w'?-99999:99999;if(chess.isDraw())return 0;
  const values={p:100,n:320,b:335,r:500,q:900,k:20000};let score=0;
  for(const row of chess.board())for(const p of row)if(p){const rank=Number(p.square[1]);let bonus=p.type==='p'?(p.color==='w'?rank-2:7-rank)*2:0;if(['d4','e4','d5','e5'].includes(p.square))bonus+=8;score+=(values[p.type]+bonus)*(p.color==='w'?1:-1)}
  return score;
}
function minimax(chess,depth,alpha,beta){
  if(depth===0||chess.isGameOver())return evaluate(chess);const maximize=chess.turn()==='w';let best=maximize?-Infinity:Infinity;
  const moves=chess.moves({verbose:true}).sort((a,b)=>(b.captured?1:0)-(a.captured?1:0));
  for(const m of moves){chess.move(m);const value=minimax(chess,depth-1,alpha,beta);chess.undo();if(maximize){best=Math.max(best,value);alpha=Math.max(alpha,value)}else{best=Math.min(best,value);beta=Math.min(beta,value)}if(beta<=alpha)break}
  return best;
}
function findAiMove(fen,level,game={}){
  const chess=new Chess(fen),moves=chess.moves({verbose:true});if(!moves.length)return null;
  if(level===1)return moves[Math.floor(Math.random()*moves.length)];const depth=level===2?1:level===3?2:3;let best=Infinity,candidates=[];
  for(const m of moves){chess.move(m);let score=minimax(chess,depth,-Infinity,Infinity)+(Math.random()-.5)*(level===4?2:18),blackKing='';for(const row of chess.board())for(const piece of row)if(piece?.type==='k'&&piece.color==='b')blackKing=piece.square;if(game.variant==='kingofthehill'&&['d4','e4','d5','e5'].includes(blackKing))score-=50000;if(game.variant==='threecheck'&&chess.isCheck())score-=700+(game.black_checks||0)*500;chess.undo();if(score<best-1){best=score;candidates=[m]}else if(Math.abs(score-best)<2)candidates.push(m)}
  return candidates[Math.floor(Math.random()*candidates.length)];
}
class AiWorkerEngine{
  constructor(){this.worker=null;this.pending=new Map();this.sequence=0}
  ensure(){
    if(this.worker||!window.Worker)return Boolean(this.worker);
    const source=`import { Chess } from 'https://cdn.jsdelivr.net/npm/chess.js@1.0.0/+esm';
const evaluate=chess=>{if(chess.isCheckmate())return chess.turn()==='w'?-99999:99999;if(chess.isDraw())return 0;const values={p:100,n:320,b:335,r:500,q:900,k:20000};let score=0;for(const row of chess.board())for(const p of row)if(p){const rank=Number(p.square[1]);let bonus=p.type==='p'?(p.color==='w'?rank-2:7-rank)*2:0;if(['d4','e4','d5','e5'].includes(p.square))bonus+=8;score+=(values[p.type]+bonus)*(p.color==='w'?1:-1)}return score};
const minimax=(chess,depth,alpha,beta)=>{if(depth===0||chess.isGameOver())return evaluate(chess);const maximize=chess.turn()==='w';let best=maximize?-Infinity:Infinity;const moves=chess.moves({verbose:true}).sort((a,b)=>(b.captured?1:0)-(a.captured?1:0));for(const move of moves){chess.move(move);const value=minimax(chess,depth-1,alpha,beta);chess.undo();if(maximize){best=Math.max(best,value);alpha=Math.max(alpha,value)}else{best=Math.min(best,value);beta=Math.min(beta,value)}if(beta<=alpha)break}return best};
onmessage=event=>{const {id,fen,level,game}=event.data;try{const chess=new Chess(fen),moves=chess.moves({verbose:true});if(!moves.length){postMessage({id,move:null});return}if(level===1){const move=moves[Math.floor(Math.random()*moves.length)];postMessage({id,move:{from:move.from,to:move.to,promotion:move.promotion||''}});return}const depth=level===2?1:level===3?2:3;let best=Infinity,candidates=[];for(const move of moves){chess.move(move);let score=minimax(chess,depth,-Infinity,Infinity)+(Math.random()-.5)*(level===4?2:18),blackKing='';for(const row of chess.board())for(const piece of row)if(piece?.type==='k'&&piece.color==='b')blackKing=piece.square;if(game.variant==='kingofthehill'&&['d4','e4','d5','e5'].includes(blackKing))score-=50000;if(game.variant==='threecheck'&&chess.isCheck())score-=700+(game.black_checks||0)*500;chess.undo();if(score<best-1){best=score;candidates=[move]}else if(Math.abs(score-best)<2)candidates.push(move)}const move=candidates[Math.floor(Math.random()*candidates.length)];postMessage({id,move:{from:move.from,to:move.to,promotion:move.promotion||''}})}catch(error){postMessage({id,error:String(error)})}};`;
    try{this.worker=new Worker(URL.createObjectURL(new Blob([source],{type:'text/javascript'})),{type:'module'});this.worker.onmessage=event=>{const pending=this.pending.get(event.data.id);if(!pending)return;this.pending.delete(event.data.id);event.data.error?pending.reject(new Error(event.data.error)):pending.resolve(event.data.move)};this.worker.onerror=()=>{this.worker?.terminate();this.worker=null}}catch{return false}return true;
  }
  think(fen,level,game){if(!this.ensure())return Promise.resolve(findAiMove(fen,level,game));return new Promise((resolve,reject)=>{const id=++this.sequence,timer=setTimeout(()=>{this.pending.delete(id);resolve(findAiMove(fen,Math.min(level,2),game))},9000);this.pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value)},reject:error=>{clearTimeout(timer);reject(error)}});this.worker.postMessage({id,fen,level,game:{variant:game.variant,black_checks:game.black_checks||0}})})}
}
const aiEngine=new AiWorkerEngine();
async function maybeAiMove(){
  const g=state.game;if(!g||state.spectator||state.replaying||g.mode!=='ai'||g.status!=='active'||g.turn!=='black'||state.aiThinking)return;
  state.aiThinking=true;renderGame();await sleep(160);
  try{const move=await aiEngine.think(g.fen,g.ai_level||2,g);if(move){const data=await api(`/api/games/${g.id}/move`,{method:'POST',body:JSON.stringify({uci:move.from+move.to+(move.promotion||''),expected_version:g.version})});state.aiThinking=false;await updateGame(data.game)}}catch(e){state.aiThinking=false;toast(e.message,'error')}
}

async function gameAction(action){
  if(!state.game||state.spectator||state.replaying)return;if(['resign','abort'].includes(action)&&!confirm(action==='resign'?'Taslim bo‘lishni tasdiqlaysizmi?':'O‘yinni bekor qilasizmi?'))return;
  try{const data=await api(`/api/games/${state.game.id}/action`,{method:'POST',body:JSON.stringify({action})});await updateGame(data.game);if(action!=='claim_timeout'){const messages={offer_draw:data.game.status==='draw'?'Durang qoidasi tasdiqlandi':'Durang taklifi yuborildi',request_takeback:'Yurishni qaytarish so‘rovi yuborildi',accept_takeback:'Oxirgi yurish qaytarildi',decline_takeback:'Qaytarish so‘rovi rad etildi'};toast(messages[action]||'Amal bajarildi','good')}}catch(e){if(action==='claim_timeout')state.timeoutClaimed=false;else toast(e.message,'error')}
}
function variantLabel(variant){return({standard:'Klassik',kingofthehill:'Taxt uchun jang',threecheck:'Uch karra shax'})[variant]||variant||'Klassik'}
function reasonLabel(reason){return({checkmate:'Shox mot',kingofthehill:'Shoh markaziy taxtni egalladi',threecheck:'Uchinchi shax berildi',stalemate:'Pat',insufficient_material:'Donalar yetarli emas',seventyfive_moves:'75 yurish qoidasi',fivefold_repetition:'Besh karra takrorlanish',threefold_repetition:'Uch karra takrorlanish',fifty_moves:'50 yurish qoidasi',timeout:'Vaqt tugadi',timeout_insufficient_material:'Vaqt tugadi, ammo mot uchun dona yetarli emas',resignation:'Taslim bo‘lish',agreement:'Kelishilgan durang',aborted:'Bekor qilindi'})[reason]||reason||'O‘yin yakuni'}
function resultState(g){const status=g.status,mine=g.my_color,draw=status==='draw'||status==='aborted',won=!state.spectator&&status===`${mine}_won`,kind=draw?'draw':won?'win':'loss',loserColor=status==='white_won'?'b':status==='black_won'?'w':'';return {status,mine,draw,won,kind,loserColor}}
function applyBoardResultEffect(g){const result=resultState(g),stage=$('#board-stage');stage.classList.remove('result-win','result-loss','result-draw');stage.classList.add(`result-${result.kind}`);state.board?.finishEffect?.(result.kind,result.loserColor)}
function showResult(g){const result=resultState(g),{status,won,draw,kind}=result,score=g.series_score||{},mine=state.spectator?(score.white||0):(score.mine||0),opponent=state.spectator?(score.black||0):(score.opponent||0),target=Math.floor((g.series_best_of||1)/2)+1,seriesOver=Math.max(mine,opponent)>=target;state.resultPresented=true;$('#result-icon').textContent=won?'♛':draw?'½':'♟';$('#result-title').textContent=state.spectator?(status==='white_won'?'OQLAR G‘ALABA':status==='black_won'?'QORALAR G‘ALABA':status==='aborted'?'BEKOR QILINDI':'DURANG'):won?'G‘ALABA':draw?'DURANG':'MAG‘LUBIYAT';$('#result-reason').textContent=`${reasonLabel(g.result_reason)} · Seriya ${mine}:${opponent}${seriesOver?' yakunlandi':''}`;$('#rematch-game').textContent=seriesOver?'↻ YANGI SERIYA':'↻ KEYINGI JANG';applyBoardResultEffect(g);openModal('#result-modal');if(state.spectator||draw)audio.draw();else if(won)audio.victory();else audio.defeat();tg?.HapticFeedback?.notificationOccurred?.(kind==='win'?'success':kind==='loss'?'error':'warning')}

function moveObject(uci){return {from:uci.slice(0,2),to:uci.slice(2,4),...(uci[4]?{promotion:uci[4]}:{})}}
function classifyLoss(loss){
  if(loss<=12)return {label:'AJOYIB',className:'',message:'Eng aniq yo‘l topildi.'};
  if(loss<=45)return {label:'YAXSHI',className:'',message:'Pozitsiya nazoratda qoldi.'};
  if(loss<=110)return {label:'NOANIQ',className:'',message:'Kuchliroq davom mavjud edi.'};
  if(loss<=230)return {label:'XATO',className:'blunder',message:'Raqibga sezilarli imkon berildi.'};
  return {label:'QO‘POL XATO',className:'blunder',message:'Pozitsiya keskin yomonlashdi.'};
}
function analyzeRecordedGame(game){
  const chess=new Chess(),rows=[],bars=[];let totalLoss=0,myMoves=0,bigMistakes=0;
  for(let index=0;index<(game.move_history||[]).length;index++){
    const recorded=game.move_history[index],mover=chess.turn(),legal=chess.moves({verbose:true});let best=mover==='w'?-Infinity:Infinity;
    for(const candidate of legal){chess.move(candidate);const score=evaluate(chess);chess.undo();best=mover==='w'?Math.max(best,score):Math.min(best,score)}
    let played;
    try{played=chess.move(moveObject(recorded.uci))}catch{played=null}
    if(!played)continue;
    const after=evaluate(chess),loss=Math.max(0,Math.min(900,mover==='w'?best-after:after-best)),kind=classifyLoss(loss),isMine=!state.spectator&&mover===game.my_color[0];
    if(isMine){totalLoss+=loss;myMoves++;if(loss>110)bigMistakes++}
    bars.push({loss,score:after});rows.push({number:Math.floor(index/2)+1,color:mover,san:recorded.san||played.san,loss,kind,isMine});
  }
  const accuracy=myMoves?Math.max(1,Math.round(100-Math.min(96,totalLoss/myMoves/3.2))):Math.max(1,Math.round(100-Math.min(96,rows.reduce((sum,row)=>sum+row.loss,0)/Math.max(1,rows.length)/3.2)));
  let summary=accuracy>=90?'Juda toza jang: taktik imkoniyatlarni deyarli boy bermadingiz.':accuracy>=75?'Mustahkam o‘yin. Noaniq yurishlardan oldin raqibning majburiy javoblarini tekshiring.':accuracy>=55?'Reja bor, ammo hisoblashni chuqurlashtirish kerak. Har yurishda shax, urish va tahdidlarni tartib bilan ko‘ring.':'Bu jang yaxshi mashg‘ulot bo‘ldi. Donani himoyasiz qoldirmaslik va shoh xavfsizligiga birinchi e’tibor bering.';
  if(bigMistakes)summary+=` Coach ${bigMistakes} ta burilish nuqtasini aniqladi.`;
  return {accuracy,summary,rows,bars};
}
function showGameReview(){
  if(!state.game?.move_history?.length)return toast('Tahlil uchun hali yurish yo‘q','error');
  const report=analyzeRecordedGame(state.game);$('#result-modal').classList.add('hidden');$('#review-accuracy').textContent=`${report.accuracy}%`;$('#coach-summary').textContent=report.summary;
  $('#review-chart').innerHTML=report.bars.map(item=>`<i class="${item.loss>110?'bad':''}" style="height:${Math.max(8,Math.min(68,12+item.loss/5))}px" title="Yo‘qotish: ${Math.round(item.loss)}"></i>`).join('');
  $('#review-list').innerHTML=report.rows.map(row=>`<div class="review-move"><b>${row.number}${row.color==='w'?'.':'...'}</b><em class="${row.kind.className}">${row.kind.label}</em><span><strong>${escapeHtml(row.san)}</strong> · ${row.kind.message}${row.isMine?' · SIZ':''}</span></div>`).join('');openModal('#review-modal');
}
async function playCinematicReplay(){
  const game=state.game;if(!game?.move_history?.length||state.replaying)return toast('Replay uchun hali yurish yo‘q','error');
  $('#result-modal').classList.add('hidden');state.replaying=true;state.historyPly=null;state.premove=null;$('#premove-banner').classList.add('hidden');renderHistoryControls();const replay=new Chess();state.board.load(replay.fen());showPositionHighlights(replay,'');$('#turn-banner').textContent='KINEMATIK REPLAY';
  for(const recorded of game.move_history){
    if(!state.replaying||state.game?.id!==game.id)return;
    let played;try{played=replay.move(moveObject(recorded.uci))}catch{played=null}if(!played)continue;
    await state.board.animateMove(recorded.uci,Boolean(played.captured));state.board.commitMove(recorded.uci,replay.fen());showPositionHighlights(replay,recorded.uci);await sleep(state.performanceMode==='battery'?45:110);
  }
  state.replaying=false;state.board.load(game.fen);showPositionHighlights(new Chess(game.fen),game.move_history?.at(-1)?.uci||'');$('#turn-banner').textContent='JANG YAKUNLANDI';showResult(game);
}
async function createRematch(){
  if(!state.game||state.spectator)return;
  const button=$('#rematch-game');setLoading(button,true,'TAYYORLANMOQDA...');
  try{const data=await api(`/api/games/${state.game.id}/rematch`,{method:'POST',body:'{}'});$('#result-modal').classList.add('hidden');toast('Revansh boshlandi','good');await enterGame(data.game)}catch(e){toast(e.message,'error')}finally{setLoading(button,false)}
}
function shareSpectator(){
  if(!state.game)return;const watchUrl=`${location.origin}/?watch=${encodeURIComponent(state.game.code)}`,text=`◉ ZAMIN Chess jangini jonli tomosha qiling: ${state.game.white_name||'Oq'} — ${state.game.black_name||'Qora'}`,telegramUrl=`https://t.me/share/url?url=${encodeURIComponent(watchUrl)}&text=${encodeURIComponent(text)}`;
  if(tg?.openTelegramLink)tg.openTelegramLink(telegramUrl);else if(navigator.share)navigator.share({title:'ZAMIN Chess',text,url:watchUrl}).catch(()=>{});else navigator.clipboard?.writeText(watchUrl).then(()=>toast('Tomosha havolasi nusxalandi','good'));
}
function shareResult(){if(!state.game)return;const g=state.game,result=resultState(g),score=g.series_score||{},mine=state.spectator?(score.white||0):(score.mine||0),opponent=state.spectator?(score.black||0):(score.opponent||0),text=`♟ ZAMIN Chess · ${result.won?'G‘alaba':result.draw?'Durang':'Jang yakuni'} · ${reasonLabel(g.result_reason)} · Seriya ${mine}:${opponent}`,url=`${location.origin}/?watch=${encodeURIComponent(g.code)}`,telegramUrl=`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;if(navigator.share)navigator.share({title:'ZAMIN Chess',text,url}).catch(()=>{});else if(tg?.openTelegramLink)tg.openTelegramLink(telegramUrl);else navigator.clipboard?.writeText(`${text}\n${url}`).then(()=>toast('Natija havolasi nusxalandi','good'))}

async function leaveGame(){
  storeValue(ACTIVE_GAME_KEY,'');if(state.socketPing){clearInterval(state.socketPing);state.socketPing=null}if(state.socket){state.socket.onclose=null;state.socket.close();state.socket=null}state.realtimeLive=false;state.replaying=false;state.historyPly=null;state.game=null;if(state.board3d)state.board3d.active=false;
  if(state.spectator){tg?.close?.();if(!tg)setTimeout(()=>{location.href='/'},50);return}
  if(state.heroArena)state.heroArena.active=true;else startHero();$('#game').classList.add('hidden');$('#lobby').classList.remove('hidden');$('#result-modal').classList.add('hidden');$('#board-stage').classList.remove('result-win','result-loss','result-draw');await loadRecent();
}
async function loadRecent(){
  if(!state.token)return;
  try{
    const data=await api('/api/me/games'),list=$('#recent-list'),rivals=$('#recent-rivals');
    if(data.profile){state.profile=data.profile;renderProfile()}
    if(!data.games.length)list.innerHTML='<div class="empty-state"><span>♟</span><p>Hali janglar yo‘q.<br>Birinchi yurishni siz boshlang.</p></div>';
    else list.innerHTML=data.games.map(g=>{const mine=g.my_color,won=g.status===`${mine}_won`,lost=g.status===`${mine==='white'?'black':'white'}_won`,label=g.status==='active'?'DAVOM ETADI':g.status==='waiting'?'KUTILMOQDA':g.status==='aborted'?'BEKOR':won?'G‘ALABA':lost?'MAG‘LUBIYAT':'DURANG',time=g.correspondence?'24 SOAT':`${Math.round(g.time_control/60)} MIN`;return `<div class="recent-item" data-game="${g.id}"><span class="recent-icon">${g.mode==='ai'?'◈':'⚔'}</span><span><b>${escapeHtml(mine==='white'?(g.black_name||'Challenge'):(g.white_name||'Raqib'))}</b><small>${g.ply_count||0} YURISH · ${time}</small></span><em class="status-tag ${won?'win':lost?'loss':''}">${label}</em></div>`}).join('');
    $$('[data-game]',list).forEach(el=>el.onclick=async()=>{try{const d=await api(`/api/games/${el.dataset.game}`);await enterGame(d.game)}catch(e){toast(e.message,'error')}});
    const recentRivals=data.rivals||[];rivals.classList.toggle('hidden',!recentRivals.length);rivals.innerHTML=recentRivals.map(r=>`<button class="rival-card" data-rival="${escapeHtml(r.id)}"><i>⚔</i><span><b>${escapeHtml(r.name)}</b><span>QAYTA CHORLASH</span></span></button>`).join('');$$('[data-rival]',rivals).forEach(button=>button.onclick=()=>showNewGame('friend',button.dataset.rival));
  }catch(e){toast(e.message,'error')}
}

setInterval(()=>{
  const g=state.game;if(!g)return;let white=g.white_ms,black=g.black_ms;if(g.status==='active'&&g.last_move_at){const elapsed=Date.now()-new Date(g.last_move_at).getTime();if(g.turn==='white')white-=elapsed;else black-=elapsed}
  const format=ms=>{ms=Math.max(0,ms);const sec=Math.ceil(ms/1000),s=sec%60,m=Math.floor(sec/60)%60,h=Math.floor(sec/3600);if(h>=24)return `${Math.floor(h/24)}K ${h%24}S`;if(h)return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;return `${Math.floor(sec/60)}:${String(s).padStart(2,'0')}`};
  $('#white-clock').textContent=format(g.my_color==='white'?white:black);$('#black-clock').textContent=format(g.my_color==='white'?black:white);
  $('#white-clock').classList.toggle('active',g.status==='active'&&g.turn===g.my_color);$('#black-clock').classList.toggle('active',g.status==='active'&&g.turn!==g.my_color);
  $('#white-clock').classList.toggle('danger',(g.my_color==='white'?white:black)<30000);$('#black-clock').classList.toggle('danger',(g.my_color==='white'?black:white)<30000);
  const running=g.turn==='white'?white:black;if(!state.spectator&&g.status==='active'&&running<=0&&!state.timeoutClaimed){state.timeoutClaimed=true;gameAction('claim_timeout')}
},250);

// Realtime uzilib qolsa, faqat shunda yengil HTTP fallback ishlaydi.
setInterval(async()=>{if(!state.game||state.realtimeLive||state.moving)return;try{const path=state.spectator?`/api/watch/${encodeURIComponent(state.game.code)}`:`/api/games/${state.game.id}`;const fresh=await api(path);await updateGame(fresh.game)}catch{}},4000);

setInterval(()=>{if(!state.puzzleStartedAt||!state.puzzle||state.puzzle.completed||$('#puzzle-modal').classList.contains('hidden'))return;const seconds=Math.floor((Date.now()-state.puzzleStartedAt)/1000);$('#puzzle-time').textContent=`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`},250);

initialize();
