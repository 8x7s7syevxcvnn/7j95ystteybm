self.onmessage = async ({data}) => {
 const {spec,base,id}=data;
 const progress=(phase,extra={})=>self.postMessage({type:'progress',id,phase,...extra});
 try {
  const root=new URL(base);
  const local=p=>{const u=new URL(p,root);if(u.origin!==root.origin||!u.pathname.startsWith(root.pathname))throw Error('Asset outside supplement');u.searchParams.set('v','3');return u;};
  async function download(file,asset,gzip=false){
   const response=await fetch(local(file),{credentials:'omit'});
   if(!response.ok)throw Error(asset+' HTTP '+response.status);
   const length=response.headers.get('Content-Length'),encoding=response.headers.get('Content-Encoding');
   let total=(!encoding||encoding.toLowerCase()==='identity')&&/^\d+$/.test(length||'')?Number(length):null;
   if(!Number.isSafeInteger(total)||total<=0)total=null;
   let loaded=0,last=0;
   progress('download',{asset,loaded,total});
   const stream=response.body?.pipeThrough(new TransformStream({
    transform(chunk,controller){loaded+=chunk.byteLength;if(total!==null&&loaded>total)total=null;const now=performance.now();if(now-last>=60){progress('download',{asset,loaded,total});last=now;}controller.enqueue(chunk);},
    flush(){if(total!==null&&loaded!==total)total=null;progress('download',{asset,loaded,total});progress(gzip?'decompress':'parse',{asset});}
   }));
   if(!stream){const buffer=await response.arrayBuffer();loaded=buffer.byteLength;if(total!==loaded)total=null;progress('download',{asset,loaded,total});progress(gzip?'decompress':'parse',{asset});return gzip?new Response(new Response(buffer).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer():buffer;}
   return new Response(gzip?stream.pipeThrough(new DecompressionStream('gzip')):stream).arrayBuffer();
  }
  let xyz,rgb,buffer;
  if(spec.encoding==='quantized_u16_xyz_then_u8_rgb_gzip'){
   if(data.buffer){progress('decompress');buffer=await new Response(new Response(data.buffer).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();}
   else buffer=await download(spec.file,'point cloud',true);
   progress('parse');
   if(buffer.byteLength!==spec.count*9)throw Error('Quantized cloud length mismatch');
   const q=new Uint16Array(buffer,0,spec.count*3);rgb=new Uint8Array(buffer,spec.count*6,spec.count*3);xyz=new Float32Array(spec.count*3);
   for(let i=0;i<xyz.length;i++)xyz[i]=q[i]*spec.step+spec.offset[i%3];
  }else{
   buffer=data.buffer||await download(spec.file,'coordinates');
   progress('parse');if(buffer.byteLength!==spec.count*12)throw Error('Cloud length mismatch');xyz=new Float32Array(buffer);
   rgb=new Uint8Array(await download(spec.colors_file,'RGB colours'));if(rgb.length!==xyz.length)throw Error('RGB count mismatch');
  }
  progress('parse');
  const colours=new Float32Array(rgb.length),lut=new Float32Array(256);
  for(let i=0;i<256;i++){let v=i/255;lut[i]=v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}
  for(let i=0;i<rgb.length;i++)colours[i]=lut[rgb[i]];
  self.postMessage({type:'result',id,xyz,colours},[xyz.buffer,colours.buffer]);
 }catch(e){self.postMessage({type:'error',id,error:e.message||'Point-cloud decoding failed'})}
};
