import * as THREE from '../vendor/three.module.min.js';
import {OrbitControls} from '../vendor/OrbitControls.js';
import {decodeCloud, createCloudProgress, cloudOverlayReady} from './cloud_loader.js';
import {createCloudDownloadQueue} from './cloud_download_queue.js';

const host = document.getElementById('hero-scan');
if (host) start().catch(error => {
  host.querySelector('[data-status]').textContent = '3D preview unavailable. Please reload.';
  host.dataset.error = error.message;
});

async function start() {
  const base = new URL('../', import.meta.url);
  const canvasBox = host.querySelector('[data-canvas]');
  const status = host.querySelector('[data-status]');
  const title = host.querySelector('[data-title]');
  const detail = host.querySelector('[data-detail]');
  const scenes = [
    {id:'office', label:'Real-camera office', link:'#reconstructions'},
    ...'ABCD'.split('').map(letter=>({id:`R${letter}01`,label:`Room ${letter}`,link:`#reconstructions`}))
  ];
  const response = await fetch(new URL('data/home_view.json?v=4',base),{credentials:'omit'});
  if (!response.ok) throw Error('Default view unavailable');
  const initial = await response.json();
  const roomResponse = await fetch(new URL('data/full_room_scans.json?v=4',base),{credentials:'omit'});
  if (!roomResponse.ok) throw Error('Full-room scan metadata unavailable');
  const fullRooms = await roomResponse.json();
  const loading = createCloudProgress(status, {showBar:false});
  const overlay = document.createElement('div'); overlay.className = 'hero-scan-loading';
  const downloads = document.createElement('div'); downloads.className = 'hero-scan-downloads';
  overlay.append(downloads, status); canvasBox.append(overlay);
  const aggregate = createCloudProgress(downloads);
  const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'hero-scan-retry';
  retry.textContent = 'Some scans could not download. Retry'; retry.hidden = true; canvasBox.after(retry);
  let aggregateState = null, sceneReady = false;
  function syncOverlay() { overlay.hidden = cloudOverlayReady(sceneReady, aggregateState); }
  const cloudQueue = createCloudDownloadQueue([initial.display_cloud, ...scenes.slice(1).map(entry => fullRooms[entry.id].cloud)], {
    base, onProgress(state) {
      aggregateState = state; aggregate.aggregate(state);
      retry.hidden = !Object.keys(state.errors).length;
      host.dataset.loadedBytes = String(state.loadedBytes);
      host.dataset.totalBytes = String(state.totalBytes);
      host.dataset.completedScans = String(state.completed);
      syncOverlay();
    }
  });
  retry.onclick = () => { cloudQueue.retryFailed(); if (!sceneReady) select(index); };
  const markerLabel=host.querySelector('[data-markers]').parentElement;
  markerLabel.lastChild.textContent='All test cameras';
  const cutLabel=document.createElement('label');
  const cutToggle=document.createElement('input');cutToggle.type='checkbox';cutToggle.checked=true;
  cutLabel.append(cutToggle,'Cutaway');markerLabel.after(cutLabel);
  const renderer = new THREE.WebGLRenderer({antialias:true,powerPreference:'low-power',preserveDrawingBuffer:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));
  renderer.localClippingEnabled = true;
  renderer.domElement.setAttribute('aria-label','Interactive laser point cloud. Drag to rotate, scroll to zoom.');
  renderer.domElement.tabIndex = 0;
  canvasBox.prepend(renderer.domElement);
  const world = new THREE.Scene();world.background=new THREE.Color('#101820');
  const camera = new THREE.PerspectiveCamera(60,1,.01,300);camera.up.set(0,0,1);
  const controls = new OrbitControls(camera,renderer.domElement);
  controls.enableDamping=false;controls.screenSpacePanning=true;controls.zoomSpeed=1.2;
  let index=0,revision=0,points=null,markers=null,loadController=null,queued=false,defaultView=null,cutPlane=null;
  const saved = new Map();
  function render(){if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;renderer.render(world,camera);});}
  controls.addEventListener('change',render);
  const observer = new ResizeObserver(()=>{
    const r=canvasBox.getBoundingClientRect();renderer.setSize(r.width,r.height,false);
    camera.aspect=r.width/r.height;camera.updateProjectionMatrix();render();
  });observer.observe(canvasBox);
  function pose(){return {position:camera.position.toArray(),target:controls.target.toArray()};}
  function setPose(p){camera.up.set(0,0,1);camera.position.fromArray(p.position);controls.target.fromArray(p.target);camera.lookAt(controls.target);controls.update();render();}
  function clear(){
    if(points){world.remove(points);points.geometry.dispose();points.material.dispose();points=null;}
    if(markers){world.remove(markers);markers.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});markers=null;}
  }
  function fit(bounds){
    const box=new THREE.Box3(new THREE.Vector3(...bounds[0]),new THREE.Vector3(...bounds[1]));
    const center=box.getCenter(new THREE.Vector3());
    const back=new THREE.Vector3(-1,-1,1.35).normalize();
    const right=new THREE.Vector3().crossVectors(new THREE.Vector3(0,0,1),back).normalize();
    const up=new THREE.Vector3().crossVectors(back,right),tv=Math.tan(Math.PI/6),th=tv*camera.aspect;
    let distance=1;
    for(const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z]){
      const q=new THREE.Vector3(x,y,z).sub(center);
      distance=Math.max(distance,q.dot(back)+Math.max(Math.abs(q.dot(right))/th,Math.abs(q.dot(up))/tv));
    }
    return {position:center.clone().addScaledVector(back,distance*1.05).toArray(),target:center.toArray()};
  }
  function glyphs(cameras){
    const group=new THREE.Group();
    for(const c of cameras){
      const mode=c.mode,kind=/panorama/i.test(mode)?'pano':/fisheye|GoPro|ultrawide/i.test(mode)?'wide':'perspective';
      const color=kind==='pano'?0x39d4a0:/GoPro|fisheye/i.test(mode)?0xffa94b:/APS-C/i.test(mode)?0xffde68:/ultrawide/i.test(mode)?0xb99bff:/iPhone/i.test(mode)?0xff8da8:0x64b9ff;
      const p=c.pose,g=new THREE.Group(),rotation=new THREE.Matrix4().set(...p.flat());
      g.position.set(p[0][3],p[1][3],p[2][3]);g.quaternion.setFromRotationMatrix(rotation);g.scale.setScalar(initial.markerSize);
      let shape=kind==='pano'?new THREE.SphereGeometry(.7,12,8):kind==='wide'?new THREE.ConeGeometry(.7,1.1,12):new THREE.BoxGeometry(1.2,.8,.8);
      if(kind==='wide')shape.rotateX(Math.PI/2);
      g.add(new THREE.Mesh(shape,new THREE.MeshBasicMaterial({color,depthTest:false,depthWrite:false,transparent:true,opacity:.95})));
      const vertices=[0,0,0,0,0,2.6,.3,0,2.1,0,0,2.6,-.3,0,2.1,0,0,2.6];
      g.add(new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(vertices,3)),new THREE.LineBasicMaterial({color,depthTest:false,depthWrite:false,transparent:true,opacity:.95})));
      g.renderOrder=10;group.add(g);
    }
    return group;
  }
  async function select(next){
    loadController?.abort();
    const controller = new AbortController(); loadController = controller;
    if(points)saved.set(scenes[index].id,pose());
    index=(next+scenes.length)%scenes.length;const current=++revision,entry=scenes[index];
    host.dataset.scene=entry.id;host.dataset.loaded='false';title.textContent=entry.label;
    host.querySelector('[data-index]').textContent=`${index+1} / ${scenes.length}`;
    detail.href=entry.link;detail.dataset.group=entry.id==='office'?'M1':entry.id;detail.dataset.dataset=entry.id==='office'?'real':'rooms';sceneReady=false;syncOverlay();loading.show('Downloading selected room scan…');delete host.dataset.error;
    clear();render();
    try {
      const url=entry.id==='office'?'gt/manifest.json':`data/groups/${entry.id}.json`;
      const r=await fetch(new URL(url,base),{credentials:'omit'});if(!r.ok)throw Error('Reference metadata unavailable');
      const doc=await r.json();if(current!==revision)return;
      const spec=entry.id==='office'?initial.display_cloud:fullRooms[entry.id].cloud;
      const cameras=entry.id==='office'?doc.cameras:doc.views;
      defaultView=entry.id==='office'?initial:fit(fullRooms[entry.id].view_bounds);setPose(saved.get(entry.id)||defaultView);
      const buffer=await cloudQueue.get(spec.file);
      // Start all remaining compressed downloads as soon as the current download finishes.
      cloudQueue.prefetchAll();
      if(current!==revision)return;
      const data=await decodeCloud(spec,{base,buffer,signal:controller.signal,onProgress:state=>{if(current===revision)loading.update(state);}});if(current!==revision)return;
      loading.update({phase:'render'});
      const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(data.xyz,3));geometry.setAttribute('color',new THREE.BufferAttribute(data.colours,3));geometry.computeBoundingSphere();
      const top=entry.id==='office'?initial.heightCut:fullRooms[entry.id].cut_height;
      cutPlane=new THREE.Plane(new THREE.Vector3(0,0,-1),top);
      const material=new THREE.PointsMaterial({vertexColors:true,color:0xffffff,size:1.25,sizeAttenuation:false,clippingPlanes:cutToggle.checked?[cutPlane]:[]});
      points=new THREE.Points(geometry,material);world.add(points);markers=glyphs(cameras);markers.visible=host.querySelector('[data-markers]').checked;world.add(markers);
      loading.clear();sceneReady=true;syncOverlay();host.dataset.loaded='true';host.dataset.cameras=String(cameras.length);host.dataset.points=String(spec.count);
      markerLabel.lastChild.textContent=entry.id==='office'?'All test cameras':'Example cameras';
      host.querySelector('[data-caption]').textContent=entry.id==='office'?`Registered laser world · ${Math.round(spec.voxel_size_m*1000)} mm display sampling · all test cameras`:`Full registered scan · ${Math.round(spec.voxel_size_m*1000)} mm display sampling`;
      render();
    }catch(error){if(current===revision&&error.name!=='AbortError'){loading.clear();status.hidden=false;status.textContent='Reference unavailable. Select another room and return to retry.';host.dataset.error=error.message;}}
  }
  host.querySelector('[data-prev]').onclick=()=>select(index-1);
  host.querySelector('[data-next]').onclick=()=>select(index+1);
  host.querySelector('[data-reset]').onclick=()=>{if(defaultView){saved.delete(scenes[index].id);setPose(defaultView);}};
  host.querySelector('[data-markers]').onchange=e=>{if(markers)markers.visible=e.target.checked;render();};
  cutToggle.onchange=()=>{if(points){points.material.clippingPlanes=cutToggle.checked?[cutPlane]:[];points.material.needsUpdate=true;render();}};
  renderer.domElement.addEventListener('keydown',e=>{if(e.key.toLowerCase()==='r'){e.preventDefault();host.querySelector('[data-reset]').click();}});
  window.addEventListener('pagehide',()=>{revision++;loadController?.abort();cloudQueue.dispose();observer.disconnect();controls.dispose();clear();renderer.dispose();});
  await select(0);
}
