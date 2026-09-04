import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Chess } from 'https://cdn.jsdelivr.net/npm/chess.js@1.0.0/+esm';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const tg = window.Telegram?.WebApp;
const state = {
  config: null, token: '', user: null, profile: null, game: null,
  socket: null, board: null, chess: new Chess(),
  selected: null, legal: [], sound: true, mode: 'friend', aiLevel: 2,
  time: 600, increment: 3, shareUrl: '', moving: false, aiThinking: false, timeoutClaimed: false, pendingChallenge: '', realtimeLive: false,
};

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
  move() { this.tone(118,.11,'sine',.085,-28);this.tone(238,.07,'triangle',.035,-75,.025);this.noise(.055,.018,260,.015); }
  capture() { this.tone(82,.28,'sine',.11,-42);this.tone(1180,.34,'triangle',.035,-730,.025,.42);this.tone(1760,.19,'sine',.018,-950,.06,.5);this.noise(.2,.065,700,.018); }
  check() { this.tone(660,.42,'sine',.055,95,0,.48);this.tone(990,.34,'sine',.026,-40,.06,.55); }
  draw() { this.tone(310,.3,'triangle',.045,-35);this.tone(265,.4,'sine',.035,-20,.12,.4); }
  defeat() { [220,185,147].forEach((n,i)=>this.tone(n,.42,'triangle',.05,-35,i*.14,.3)); }
  victory() { [392,494,587,784].forEach((n,i)=>this.tone(n,.5,'sine',.052,35,i*.11,.38)); }
}
const audio = new AudioForge();

class ChessArena3D {
  constructor(container, {interactive = true, hero = false} = {}) {
    this.container = container; this.interactive = interactive; this.hero = hero;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(hero ? 34 : 40, 1, .1, 100);
    this.camera.position.set(hero ? 5.8 : 0, hero ? 6.3 : 8.4, hero ? 6.8 : 8.1);
    this.renderer = new THREE.WebGLRenderer({antialias: true, alpha: true, powerPreference: 'high-performance'});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, hero ? 1.35 : innerWidth < 700 ? 1.4 : 1.8));
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace; this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.12;
    container.append(this.renderer.domElement);
    this.root = new THREE.Group(); this.scene.add(this.root);
    this.pieces = new Map(); this.squares = []; this.markers = [];
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
    this.clock = new THREE.Clock(); this.loop();
  }
  buildLights() {
    this.scene.add(new THREE.HemisphereLight(0xd9f7ff,0x211208,1.55));
    const key=new THREE.SpotLight(0xffdfa2,105,32,.55,.72);key.position.set(-5,10,6);key.castShadow=true;key.shadow.mapSize.set(this.hero?512:1024,this.hero?512:1024);key.shadow.bias=-.00025;this.scene.add(key);
    const cool=new THREE.SpotLight(0x68dce8,72,28,.65,.8);cool.position.set(6,7,-6);this.scene.add(cool);
    const rim=new THREE.PointLight(0xff934f,24,18);rim.position.set(-6,2,-3);this.scene.add(rim);
  }
  buildBoard() {
    const baseMat=new THREE.MeshPhysicalMaterial({color:0x111a22,roughness:.23,metalness:.72,clearcoat:.72});
    const base=new THREE.Mesh(new THREE.BoxGeometry(9.45,.38,9.45),baseMat);base.position.y=-.28;base.receiveShadow=true;this.root.add(base);
    const rim=new THREE.Mesh(new THREE.BoxGeometry(8.72,.16,8.72),new THREE.MeshStandardMaterial({color:0xbd7d36,metalness:.78,roughness:.28}));rim.position.y=-.035;this.root.add(rim);
    const light=new THREE.MeshPhysicalMaterial({color:0xe0cfb3,roughness:.42,metalness:.04,clearcoat:.28});
    const dark=new THREE.MeshPhysicalMaterial({color:0x315463,roughness:.36,metalness:.18,clearcoat:.4});
    for (let r=0;r<8;r++) for(let f=0;f<8;f++) {
      const mesh=new THREE.Mesh(new THREE.BoxGeometry(.985,.14,.985),(f+r)%2?dark:light);
      const square = `${'abcdefgh'[f]}${r+1}`;
      mesh.position.set(f-3.5,.065,3.5-r);mesh.receiveShadow=true;mesh.userData.square=square;
      this.root.add(mesh); this.squares.push(mesh);
    }
    const floor=new THREE.Mesh(new THREE.CircleGeometry(12,64),new THREE.MeshStandardMaterial({color:0x061017,transparent:true,opacity:.78,roughness:1}));floor.rotation.x=-Math.PI/2;floor.position.y=-.49;floor.receiveShadow=true;this.scene.add(floor);
  }
  material(color) {
    return color==='w'
      ? new THREE.MeshPhysicalMaterial({color:0xf1e5ce,roughness:.22,metalness:.08,clearcoat:1,clearcoatRoughness:.11})
      : new THREE.MeshPhysicalMaterial({color:0x263b49,roughness:.18,metalness:.62,clearcoat:.9,clearcoatRoughness:.13});
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
    const g=new THREE.Group(),m=this.material(color),accent=this.accent(color);this.base(m,accent,g);
    if(type==='p'){
      this.lathe([[.28,.31],[.23,.39],[.15,.53],[.14,.68],[.19,.76]],m,g);this.ring(.19,.76,accent,g,.028);this.part(new THREE.SphereGeometry(.235,28,20),m,1.01,g);
    } else if(type==='r'){
      this.lathe([[.3,.31],[.28,.42],[.25,.78],[.33,.87],[.38,.96]],m,g,24);this.ring(.33,.88,accent,g,.032);this.part(new THREE.CylinderGeometry(.39,.37,.2,8),m,1.04,g);
      for(let i=0;i<4;i++){const tooth=this.part(new THREE.BoxGeometry(.19,.2,.2),m,1.22,g);tooth.position.x=Math.cos(i*Math.PI/2+.4)*.27;tooth.position.z=Math.sin(i*Math.PI/2+.4)*.27;}
    } else if(type==='n'){
      this.lathe([[.29,.31],[.3,.43],[.24,.52],[.22,.61]],m,g,28);
      const shape=new THREE.Shape();shape.moveTo(-.28,-.48);shape.bezierCurveTo(-.36,-.16,-.27,.1,-.08,.25);shape.bezierCurveTo(.03,.36,.04,.54,-.04,.68);shape.lineTo(.14,.59);shape.bezierCurveTo(.33,.38,.35,.05,.26,-.18);shape.lineTo(.43,-.27);shape.lineTo(.23,-.4);shape.closePath();
      const horse=new THREE.Mesh(new THREE.ExtrudeGeometry(shape,{depth:.33,bevelEnabled:true,bevelSegments:3,steps:1,bevelSize:.045,bevelThickness:.045}),m);horse.geometry.center();horse.position.set(-.02,1.04,-.165);horse.castShadow=true;g.add(horse);
      const mane=this.part(new THREE.BoxGeometry(.07,.66,.38),accent,1.13,g);mane.rotation.z=-.14;mane.position.x=.16;
      for(const side of [-1,1]){const ear=this.part(new THREE.ConeGeometry(.055,.24,10),m,1.63,g);ear.position.x=.02;ear.position.z=side*.11;ear.rotation.z=-.12;}
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
    g.scale.setScalar(type==='p'?.73:.71);g.rotation.y=color==='b'?Math.PI:0;
    g.traverse(o=>{o.userData.pieceRoot=g}); return g;
  }
  squarePosition(square) { return new THREE.Vector3(square.charCodeAt(0)-97-3.5,.14,3.5-(Number(square[1])-1)); }
  load(fen) {
    for(const p of this.pieces.values()) this.root.remove(p); this.pieces.clear();
    const chess = new Chess(fen);
    for(const row of chess.board()) for(const p of row) if(p) {
      const square=`${'abcdefgh'[p.square.charCodeAt(0)-97]}${p.square[1]}`;
      const model=this.piece(p.type,p.color); model.position.copy(this.squarePosition(square));
      model.userData={...model.userData,square,color:p.color,type:p.type}; this.root.add(model);this.pieces.set(square,model);
    }
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
  clearMarkers(){this.markers.forEach(m=>this.root.remove(m));this.markers=[]}
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
    const start=mover.position.clone(),end=this.squarePosition(to),victim=this.pieces.get(to);
    let weapon=null;if(captured){const arsenal={r:'hammer',n:'lance',b:'staff',p:'spear'};weapon=this.weapon(arsenal[mover.userData.type]||'sword');weapon.position.set(0,.65,.05);weapon.rotation.z=-1.5;mover.add(weapon);audio.capture()}else audio.move();
    const duration=captured?760:430,t0=performance.now();
    await new Promise(resolve=>{const tick=(time)=>{const p=Math.min(1,(time-t0)/duration),ease=1-Math.pow(1-p,3);mover.position.lerpVectors(start,end,ease);mover.position.y=.14+Math.sin(p*Math.PI)*(captured ? .34 : .16);if(weapon)weapon.rotation.z=-1.5+p*3.1;if(victim&&p>.42){const q=(p-.42)/.58;victim.rotation.z=q*1.3;victim.scale.setScalar(Math.max(.05,1-q*.95));victim.position.y=.14-q*.45}p<1?requestAnimationFrame(tick):resolve()};requestAnimationFrame(tick)});
    if(weapon)mover.remove(weapon);
  }
  resize(){const w=this.container.clientWidth,h=this.container.clientHeight;if(!w||!h)return;this.renderer.setSize(w,h,false);this.camera.aspect=w/h;this.camera.updateProjectionMatrix();if(!this.hero)this.orient(this.viewColor||'white')}
  loop(){requestAnimationFrame(()=>this.loop());this.controls.update();if(this.hero)this.root.position.y=Math.sin(performance.now()/900)*.04;this.renderer.render(this.scene,this.camera)}
}

function startHero() {
  const arena=new ChessArena3D($('#hero-stage'),{interactive:false,hero:true});arena.load(new Chess().fen());
  arena.root.rotation.y=-.28;
}

async function initialize() {
  try {
    state.config=await api('/api/config');
    const launchFragment=new URLSearchParams(location.hash.slice(1));
    const launchQuery=new URLSearchParams(location.search);
    const launchTicket=launchQuery.get('ticket')||launchFragment.get('ticket')||'';
    const fragmentStartParam=launchQuery.get('startapp')||launchFragment.get('startapp')||'';
    const session=await api('/api/session',{method:'POST',body:JSON.stringify({
      init_data:tg?.initData||'',
      launch_ticket:launchTicket,
    })});
    // Remove the short-lived credential from the address after it is accepted.
    // The longer API session token remains only in this page's memory.
    if(launchTicket) history.replaceState(null,'',location.pathname);
    Object.assign(state,{token:session.token,user:session.user,profile:session.profile});
    renderProfile(); startHero(); bindUI();
    $('#app').classList.remove('hidden'); await sleep(350); $('#boot').classList.add('out'); setTimeout(()=>$('#boot').remove(),700);
    if(!session.registered) openModal('#onboarding'); else await loadRecent();
    const startParam=tg?.initDataUnsafe?.start_param||fragmentStartParam||new URLSearchParams(location.search).get('startapp');
    if(startParam?.startsWith('join_')) {
      if(session.registered) await joinChallenge(startParam.slice(5));
      else state.pendingChallenge=startParam.slice(5);
    }
  } catch(error) {
    $('#boot').classList.add('out'); $('#app').classList.remove('hidden');
    setTimeout(()=>$('#boot')?.remove(),500); toast(error.message,'error');
    document.body.insertAdjacentHTML('beforeend',`<div class="modal-backdrop"><div class="modal"><div class="modal-symbol">♞</div><h2>Telegram orqali oching</h2><p>${escapeHtml(error.message)}</p><small>Bot chatiga qayting, /start yuboring va bot yuborgan yangi ARENANI OCHISH tugmasini bosing.</small></div></div>`);
  }
}

function bindUI() {
  $$('[data-open]').forEach(btn=>btn.onclick=()=>showNewGame(btn.dataset.open));
  $$('.modal-close').forEach(btn=>btn.onclick=()=>closeModal(btn));
  $$('.modal-backdrop').forEach(back=>back.addEventListener('click',e=>{if(e.target===back&&back.id!=='onboarding')back.classList.add('hidden')}));
  $$('.ai-levels button').forEach(btn=>btn.onclick=()=>{$$('.ai-levels button').forEach(x=>x.classList.remove('active'));btn.classList.add('active');state.aiLevel=+btn.dataset.level});
  $$('.time-grid button').forEach(btn=>btn.onclick=()=>{$$('.time-grid button').forEach(x=>x.classList.remove('active'));btn.classList.add('active');state.time=+btn.dataset.time;state.increment=+btn.dataset.inc});
  $('#create-game').onclick=createGame;
  $('#profile-form').onsubmit=saveProfile;
  $('#join-form').onsubmit=e=>{e.preventDefault();joinChallenge($('#join-code').value)};
  $('#refresh-games').onclick=loadRecent;
  $('#share-challenge').onclick=shareChallenge; $('#copy-challenge').onclick=copyChallenge;
  $('#leave-game').onclick=leaveGame; $('#result-home').onclick=()=>{closeModal($('#result-home'));leaveGame()};
  $('#view-toggle').onclick=()=>state.board?.orient(state.board.viewColor==='white'?'black':'white');
  $('#panel-toggle').onclick=()=>$('.game-panel').classList.toggle('open');
  $$('[data-panel-open]').forEach(btn=>btn.onclick=()=>$('.game-panel').classList.add('open'));
  $$('[data-panel-close]').forEach(btn=>btn.onclick=()=>$('.game-panel').classList.remove('open'));
  $('#camera-tab').onclick=()=>{state.board?.orient(state.board.viewColor==='white'?'black':'white');if(innerWidth<=900)$('.game-panel').classList.remove('open')};
  $$('[data-sound-toggle]').forEach(btn=>btn.onclick=()=>{state.sound=!state.sound;$$('[data-sound-toggle] b').forEach(icon=>icon.textContent=state.sound?'◖':'×');if(state.sound)audio.move();toast(state.sound?'Ovoz yoqildi':'Ovoz o‘chirildi')});
  $$('[data-action]').forEach(btn=>btn.onclick=()=>gameAction(btn.dataset.action));
  document.addEventListener('pointerdown',()=>audio.wake(),{once:true});
}

function escapeHtml(text=''){const d=document.createElement('div');d.textContent=text;return d.innerHTML}
function renderProfile(){
  const name=state.profile?.full_name||[state.user?.first_name,state.user?.last_name].filter(Boolean).join(' ')||'O‘yinchi';
  $('#profile-name').textContent=name;$('#self-name').textContent=name;$('#profile-initial').textContent=name[0].toUpperCase();
  const p=state.profile||{};$('#profile-rating').textContent=p.rating||1200;$('#games-count').textContent=p.games_played||0;$('#wins-count').textContent=p.wins||0;$('#losses-count').textContent=p.losses||0;$('#draws-count').textContent=p.draws||0;$('#rank-needed').textContent=Math.max(0,1400-(p.rating||1200));
}

async function saveProfile(event){
  event.preventDefault();const btn=$('button[type="submit"]',event.currentTarget);setLoading(btn,true);
  try{const data=await api('/api/profile',{method:'POST',body:JSON.stringify({full_name:$('#full-name').value,phone:$('#phone').value})});state.profile=data.profile;renderProfile();closeModal(btn);toast('Arena pasporti tayyor','good');await loadRecent();if(state.pendingChallenge){const code=state.pendingChallenge;state.pendingChallenge='';await joinChallenge(code)}}
  catch(e){toast(e.message,'error')}finally{setLoading(btn,false)}
}

function showNewGame(mode){state.mode=mode;$('#new-game-title').textContent=mode==='ai'?'Sun’iy aql bilan jang':'Do‘stni chorlash';$('#ai-options').classList.toggle('hidden',mode!=='ai');openModal('#new-game-modal')}

async function createGame(){
  const btn=$('#create-game');setLoading(btn,true);
  try{const data=await api('/api/games',{method:'POST',body:JSON.stringify({mode:state.mode,time_control:state.time,increment:state.increment,ai_level:state.aiLevel})});closeModal(btn);state.shareUrl=data.share_url;if(state.mode==='friend'){state.game=data.game;$('#challenge-code').textContent=data.game.code;openModal('#challenge-modal');await subscribe(data.game.id)}else await enterGame(data.game)}
  catch(e){toast(e.message,'error')}finally{setLoading(btn,false)}
}

async function joinChallenge(raw){
  const challenge=(raw||'').trim().toUpperCase();if(!challenge)return;
  try{const data=await api(`/api/challenges/${encodeURIComponent(challenge)}/join`,{method:'POST',body:'{}'});closeModal($('#challenge-modal'));toast('Challenge qabul qilindi','good');await enterGame(data.game)}catch(e){toast(e.message,'error')}
}

function shareChallenge(){
  const text=`⚔️ Men sizni ZAMIN 3D Chess jangiga chorlayman!\n\nChallenge kodi: ${state.game?.code}\nTaxtada ko‘rishamiz.`;
  const url=`https://t.me/share/url?url=${encodeURIComponent(state.shareUrl)}&text=${encodeURIComponent(text)}`;
  tg?.openTelegramLink?.(url) || window.open(url,'_blank');
}
async function copyChallenge(){try{await navigator.clipboard.writeText(state.shareUrl);toast('Havola nusxalandi','good')}catch{toast(state.shareUrl)}}

async function subscribe(gameId){
  if(state.socket){state.socket.onclose=null;state.socket.close()}
  const protocol=location.protocol==='https:'?'wss:':'ws:';
  const socket=new WebSocket(`${protocol}//${location.host}/ws/games/${gameId}`);
  state.socket=socket;
  socket.onopen=()=>socket.send(JSON.stringify({token:state.token}));
  socket.onmessage=event=>{try{state.realtimeLive=true;$('#live-indicator').classList.add('live');const payload=JSON.parse(event.data),game=payload.game;if(!game)return;if($('#challenge-modal:not(.hidden)')&&game.status==='active'){closeModal($('#challenge-modal'));enterGame(game)}else updateGame(game)}catch{}};
  socket.onerror=()=>{state.realtimeLive=false;$('#live-indicator').classList.remove('live')};
  socket.onclose=()=>{state.realtimeLive=false;$('#live-indicator').classList.remove('live');if(state.game?.id===gameId)setTimeout(()=>subscribe(gameId),1800)};
}

async function enterGame(game){
  state.game=game;state.chess=new Chess(game.fen);state.selected=null;state.timeoutClaimed=false;
  $('.game-panel').classList.remove('open');
  $('#lobby').classList.add('hidden');$('#game').classList.remove('hidden');$('#game-code').textContent=game.code;
  $('#opponent-name').textContent=game.my_color==='white'?(game.black_name||'Raqib kutilmoqda'):(game.white_name||'Raqib');
  if(!state.board)state.board=new ChessArena3D($('#board-stage'));state.board.orient(game.my_color);state.board.load(game.fen);
  renderGame();await subscribe(game.id);maybeAiMove();
}

async function updateGame(game){
  if(!state.game||game.id!==state.game.id)return;
  if(game.version<=state.game.version)return;
  const old=state.game,last=game.move_history?.at(-1),hasNewMove=(game.move_history?.length||0)>(old.move_history?.length||0);
  state.game=game;state.timeoutClaimed=false;
  if(hasNewMove&&last){state.moving=true;await state.board.animateMove(last.uci,last.san.includes('x'));state.board.load(game.fen);state.moving=false;if(last.san.includes('+')||last.san.includes('#'))audio.check()}
  else state.board.load(game.fen);
  state.chess=new Chess(game.fen);renderGame();maybeAiMove();
}

function renderGame(){
  const g=state.game;if(!g)return;
  $('#game-code').textContent=g.code;$('#opponent-name').textContent=g.my_color==='white'?(g.black_name||'Raqib kutilmoqda'):(g.white_name||'Raqib');
  const mine=g.my_color,active=g.status==='active'&&g.turn===mine;
  $('#turn-banner').textContent=g.status==='waiting'?'RAQIB KUTILMOQDA':g.status!=='active'?'JANG YAKUNLANDI':active?'SIZNING YURISHINGIZ':g.mode==='ai'&&g.turn==='black'?'AI O‘YLAYAPTI...':'RAQIB YURISHI';
  $('#turn-banner').style.borderColor=active?'#b89152':'#40444c';
  const moves=g.move_history||[],list=$('#moves-list');
  if(!moves.length)list.innerHTML='<div class="moves-empty">Birinchi yurish tarixni boshlaydi.</div>';
  else{let html='';for(let i=0;i<moves.length;i+=2)html+=`<div class="move-row"><span>${i/2+1}.</span><b>${escapeHtml(moves[i]?.san||'')}</b><b>${escapeHtml(moves[i+1]?.san||'')}</b></div>`;list.innerHTML=html;list.scrollTop=list.scrollHeight}
  const offer=g.draw_offer_by&&g.draw_offer_by!==String(state.user.id);$('#draw-offer').classList.toggle('hidden',!offer);
  $$('[data-action="offer_draw"],[data-action="resign"]').forEach(button=>button.disabled=g.status!=='active');
  if(!['waiting','active'].includes(g.status)&&!$('#result-modal:not(.hidden)'))showResult(g);
}

function onSquare(square){
  const g=state.game;if(!g||g.status!=='active'||g.turn!==g.my_color||state.moving||state.aiThinking)return;
  const piece=state.chess.get(square),myColor=g.my_color[0];
  if(!state.selected){if(piece?.color===myColor)selectSquare(square);return}
  if(piece?.color===myColor){selectSquare(square);return}
  const candidate=state.legal.find(m=>m.to===square);if(candidate)submitMove(state.selected,square,candidate);else{state.selected=null;state.board.clearMarkers()}
}
function selectSquare(square){state.selected=square;state.legal=state.chess.moves({square,verbose:true});state.board.showMoves(square,state.legal.map(m=>m.to));tg?.HapticFeedback?.selectionChanged?.()}

async function choosePromotion(){
  return new Promise(resolve=>{
    const back=document.createElement('div');back.className='modal-backdrop';back.innerHTML='<div class="modal"><span class="eyebrow">PROMOTION</span><h2>Donani tanlang</h2><div class="segmented"><button data-p="q">♛</button><button data-p="r">♜</button><button data-p="b">♝</button><button data-p="n">♞</button></div></div>';
    document.body.append(back);$$('[data-p]',back).forEach(b=>b.onclick=()=>{resolve(b.dataset.p);back.remove()});
  });
}
async function submitMove(from,to,moveInfo){
  let promotion=moveInfo.promotion||'';if(promotion&&state.chess.get(from)?.type==='p')promotion=await choosePromotion();
  const uci=from+to+promotion;state.selected=null;state.board.clearMarkers();state.moving=true;
  try{const data=await api(`/api/games/${state.game.id}/move`,{method:'POST',body:JSON.stringify({uci,expected_version:state.game.version})});state.moving=false;await updateGame(data.game)}catch(e){state.moving=false;toast(e.message,'error');try{const fresh=await api(`/api/games/${state.game.id}`);await updateGame(fresh.game)}catch{}}
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
function findAiMove(fen,level){
  const chess=new Chess(fen),moves=chess.moves({verbose:true});if(!moves.length)return null;
  if(level===1)return moves[Math.floor(Math.random()*moves.length)];const depth=level===2?1:level===3?2:3;let best=Infinity,candidates=[];
  for(const m of moves){chess.move(m);const score=minimax(chess,depth,-Infinity,Infinity)+(Math.random()-.5)*(level===4?2:18);chess.undo();if(score<best-1){best=score;candidates=[m]}else if(Math.abs(score-best)<2)candidates.push(m)}
  return candidates[Math.floor(Math.random()*candidates.length)];
}
async function maybeAiMove(){
  const g=state.game;if(!g||g.mode!=='ai'||g.status!=='active'||g.turn!=='black'||state.aiThinking)return;
  state.aiThinking=true;renderGame();await sleep(450);
  try{const move=findAiMove(g.fen,g.ai_level||2);if(move){const data=await api(`/api/games/${g.id}/move`,{method:'POST',body:JSON.stringify({uci:move.from+move.to+(move.promotion||''),expected_version:g.version})});state.aiThinking=false;await updateGame(data.game)}}catch(e){state.aiThinking=false;toast(e.message,'error')}
}

async function gameAction(action){
  if(!state.game)return;if(['resign','abort'].includes(action)&&!confirm(action==='resign'?'Taslim bo‘lishni tasdiqlaysizmi?':'O‘yinni bekor qilasizmi?'))return;
  try{const data=await api(`/api/games/${state.game.id}/action`,{method:'POST',body:JSON.stringify({action})});await updateGame(data.game);if(action!=='claim_timeout')toast(action==='offer_draw'?(data.game.status==='draw'?'Durang qoidasi tasdiqlandi':'Durang taklifi yuborildi'):'Amal bajarildi','good')}catch(e){if(action==='claim_timeout')state.timeoutClaimed=false;else toast(e.message,'error')}
}
function reasonLabel(reason){return({checkmate:'Shox mot',stalemate:'Pat',insufficient_material:'Donalar yetarli emas',seventyfive_moves:'75 yurish qoidasi',fivefold_repetition:'Besh karra takrorlanish',threefold_repetition:'Uch karra takrorlanish',fifty_moves:'50 yurish qoidasi',timeout:'Vaqt tugadi',timeout_insufficient_material:'Vaqt tugadi, ammo mot uchun dona yetarli emas',resignation:'Taslim bo‘lish',agreement:'Kelishilgan durang',aborted:'Bekor qilindi'})[reason]||reason||'O‘yin yakuni'}
function showResult(g){const mine=g.my_color,status=g.status;const won=status===`${mine}_won`,draw=status==='draw';$('#result-icon').textContent=won?'♛':draw?'½':'♟';$('#result-title').textContent=won?'G‘ALABA':draw?'DURANG':'MAG‘LUBIYAT';$('#result-reason').textContent=reasonLabel(g.result_reason);openModal('#result-modal');if(won)audio.victory();else if(draw)audio.draw();else audio.defeat()}

async function leaveGame(){
  if(state.socket){state.socket.onclose=null;state.socket.close();state.socket=null}state.realtimeLive=false;state.game=null;$('#game').classList.add('hidden');$('#lobby').classList.remove('hidden');$('#result-modal').classList.add('hidden');await loadRecent();
}
async function loadRecent(){
  if(!state.token)return;try{const data=await api('/api/me/games'),list=$('#recent-list');if(data.profile){state.profile=data.profile;renderProfile()}if(!data.games.length){list.innerHTML='<div class="empty-state"><span>♟</span><p>Hali janglar yo‘q.<br>Birinchi yurishni siz boshlang.</p></div>';return}list.innerHTML=data.games.map(g=>{const mine=g.my_color,won=g.status===`${mine}_won`,lost=g.status===`${mine==='white'?'black':'white'}_won`,label=g.status==='active'?'DAVOM ETADI':g.status==='waiting'?'KUTILMOQDA':g.status==='aborted'?'BEKOR':won?'G‘ALABA':lost?'MAG‘LUBIYAT':'DURANG';return `<div class="recent-item" data-game="${g.id}"><span class="recent-icon">${g.mode==='ai'?'◈':'⚔'}</span><span><b>${escapeHtml(mine==='white'?(g.black_name||'Challenge'):(g.white_name||'Raqib'))}</b><small>${g.move_history?.length||0} YURISH · ${g.time_control/60} MIN</small></span><em class="status-tag ${won?'win':lost?'loss':''}">${label}</em></div>`}).join('');$$('[data-game]',list).forEach(el=>el.onclick=async()=>{try{const d=await api(`/api/games/${el.dataset.game}`);await enterGame(d.game)}catch(e){toast(e.message,'error')}})}catch(e){toast(e.message,'error')}
}

setInterval(()=>{
  const g=state.game;if(!g)return;let white=g.white_ms,black=g.black_ms;if(g.status==='active'&&g.last_move_at){const elapsed=Date.now()-new Date(g.last_move_at).getTime();if(g.turn==='white')white-=elapsed;else black-=elapsed}
  const format=ms=>{ms=Math.max(0,ms);const sec=Math.ceil(ms/1000),m=Math.floor(sec/60),s=sec%60;return `${m}:${String(s).padStart(2,'0')}`};
  $('#white-clock').textContent=format(g.my_color==='white'?white:black);$('#black-clock').textContent=format(g.my_color==='white'?black:white);
  $('#white-clock').classList.toggle('active',g.status==='active'&&g.turn===g.my_color);$('#black-clock').classList.toggle('active',g.status==='active'&&g.turn!==g.my_color);
  $('#white-clock').classList.toggle('danger',(g.my_color==='white'?white:black)<30000);$('#black-clock').classList.toggle('danger',(g.my_color==='white'?black:white)<30000);
  const running=g.turn==='white'?white:black;if(g.status==='active'&&running<=0&&!state.timeoutClaimed){state.timeoutClaimed=true;gameAction('claim_timeout')}
},250);

// Realtime uzilib qolsa, faqat shunda yengil HTTP fallback ishlaydi.
setInterval(async()=>{if(!state.game||state.realtimeLive||state.moving)return;try{const fresh=await api(`/api/games/${state.game.id}`);await updateGame(fresh.game)}catch{}},4000);

initialize();
