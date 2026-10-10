import { createHash } from 'node:crypto';

/** Shared low-level input validators. Each record family keeps its own error noun ("case", "coverage") so messages are unchanged. */
export const CONTROL=/[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/;

export const sha256Hex=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');

/** Opaque host ID (record, event, artifact, consumer). */
export const validId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(value);

export function plain(value:unknown,label:string):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)throw Error(`Invalid ${label}`);return value as Record<string,unknown>}
export function exact(row:Record<string,unknown>,allowed:string[],label:string):void{if(Object.keys(row).some(key=>!allowed.includes(key)))throw Error(`${label} contains host-owned or unknown fields`)}

export function fieldValidators(noun:string){
  function text(value:unknown,label:string,max:number,min=1):string{if(typeof value!=='string'||value.trim().length<min||value.length>max||value!==value.normalize('NFC')||CONTROL.test(value))throw Error(`Invalid ${noun} ${label}`);return value}
  function key(value:unknown,label:string,max=160):string{const result=text(value,label,max);if(!/^[a-z0-9][a-z0-9._:/-]*$/.test(result))throw Error(`Invalid ${noun} ${label}`);return result}
  function id(value:unknown,label:string):string{const result=text(value,label,80);if(!/^[a-z0-9][a-z0-9-]{0,79}$/.test(result))throw Error(`Invalid ${noun} ${label}`);return result}
  function revision(value:unknown,label:string):number{if(!Number.isSafeInteger(value)||Number(value)<1)throw Error(`Invalid ${noun} ${label}`);return Number(value)}
  function ids(value:unknown,label:string,max=10,minimum=0):string[]{if(!Array.isArray(value)||value.length<minimum||value.length>max)throw Error(`Invalid ${noun} ${label}`);const result=value.map(item=>id(item,label));if(new Set(result).size!==result.length)throw Error(`Duplicate ${noun} ${label}`);return result}
  return {text,key,id,revision,ids};
}
