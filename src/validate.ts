import { createHash } from 'node:crypto';

/** Shared low-level input validators. Each record family keeps its own error noun ("case", "coverage") so messages are unchanged. */

/** Characters that never belong in a single-line field: C0 controls, DEL, C1 controls and the bidirectional overrides/isolates that can disguise what a record says. */
export const CONTROL=/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;
/** The same for free text, where a tab or line feed is fine. */
export const TEXT_CONTROL=/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;
export const TEXT_CONTROL_G=new RegExp(TEXT_CONTROL.source,'g');

export const sha256Hex=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');

/** Opaque host ID (record, event, artifact, consumer). */
export const validId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(value);

export function plain(value:unknown,label:string):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)throw Error(`Invalid ${label}`);return value as Record<string,unknown>}
export function exact(row:Record<string,unknown>,allowed:string[],label:string):void{if(Object.keys(row).some(key=>!allowed.includes(key)))throw Error(`${label} contains host-owned or unknown fields`)}

/**
 * A1 (owner decision 2026-10-28): cosmetic prose is clamped at the stored bound instead of being refused by Pi's argument
 * validator. These fields are labels a coordinator reads, not identity a review matches on, so a long value still admits and
 * the caller is told exactly what was cut. Only a length overflow is cosmetic: a wrong type, an empty value or control text
 * keeps the hard refusal (`text()` below / the tool's own validation). tasks.ts P2 already does this for task surface/risk;
 * the declared bounds in tool-schemas.ts sit well above these stored ones (at least 4x, never below 2000 characters).
 */
export const PROSE_CAPS = {
  candidate: { surface: 200, risk: 200, limitations: 1500, control: 1000, note: 300, expectedPolicy: 1000 },
  note: { text: 2000, surface: 200, risk: 200 },
  surface: { component: 200, entryPoint: 200, text: 1000 },
  finish: { partial: 600 },
} as const;

/** Truncate the over-long cosmetic fields of `fields` in place and return one trace line per cut. Control text is left for the hard refusal. */
export function clampProseInPlace(fields:Record<string,unknown>,caps:Readonly<Record<string,number>>):string[]{
  const warnings:string[]=[];
  for(const [field,limit] of Object.entries(caps)){
    const value=fields[field];
    if(typeof value!=='string'||value.length<=limit||value.trim().length<1||TEXT_CONTROL.test(value))continue;
    fields[field]=value.slice(0,limit);
    warnings.push(`truncated:${field} (stored ${limit} of ${value.length} characters)`);
  }
  return warnings;
}

export function fieldValidators(noun:string){
  function text(value:unknown,label:string,max:number,min=1):string{if(typeof value!=='string'||value.trim().length<min||value.length>max||value!==value.normalize('NFC')||CONTROL.test(value))throw Error(`Invalid ${noun} ${label}`);return value}
  function key(value:unknown,label:string,max=160):string{const result=text(value,label,max);if(!/^[a-z0-9][a-z0-9._:/-]*$/.test(result))throw Error(`Invalid ${noun} ${label}`);return result}
  function id(value:unknown,label:string):string{const result=text(value,label,80);if(!/^[a-z0-9][a-z0-9-]{0,79}$/.test(result))throw Error(`Invalid ${noun} ${label}`);return result}
  function revision(value:unknown,label:string):number{if(!Number.isSafeInteger(value)||Number(value)<1)throw Error(`Invalid ${noun} ${label}`);return Number(value)}
  function ids(value:unknown,label:string,max=10,minimum=0):string[]{if(!Array.isArray(value)||value.length<minimum||value.length>max)throw Error(`Invalid ${noun} ${label}`);const result=value.map(item=>id(item,label));if(new Set(result).size!==result.length)throw Error(`Duplicate ${noun} ${label}`);return result}
  return {text,key,id,revision,ids};
}
