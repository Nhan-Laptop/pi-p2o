import { describe, expect, it } from 'vitest';
import { HttpSessions, responseHead } from '../../src/http-session.js';

const url = new URL('https://example.com/app/login');
const cookies = (...values:string[]): Array<[string,string]> => values.map(value=>['set-cookie', value]);

describe('bounded HTTP sessions and trusted header framing', () => {
  it('skips informational headers and ignores cookie/redirect words in the body', () => {
    const head=responseHead('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nX-Test: yes\r\n\r\nHTTP/1.1 302 Found\r\nLocation: /bad\r\nSet-Cookie: fake=yes');
    expect(head).toEqual({status:200,complete:true,headers:[['x-test','yes']]});
    expect(responseHead('HTTP/2 204\r\n\r\n')).toEqual({status:204,complete:true,headers:[]});
    expect(responseHead('HTTP/1.1 200 OK\r\nSet-Cookie: partial=')).toMatchObject({complete:false,headers:[]});
    expect(responseHead('HTTP/1.1 200 OK\r\nFolded without colon\r\n\r\n')).toMatchObject({complete:false});
  });
  it('isolates actors, principals and origins; none disables automatic state', () => {
    const jars = new HttpSessions();jars.store('owner','alice',url,cookies('sid=alice; Path=/'));
    expect(jars.header('owner','alice',url)).toBe('sid=alice');
    expect(jars.header('owner','bob',url)).toBeUndefined();expect(jars.header('worker','alice',url)).toBeUndefined();
    expect(jars.header('owner','alice',new URL('https://example.com:444/'))).toBeUndefined();
    jars.store('owner','none',url,cookies('sid=disabled; Path=/'));
    expect(jars.header('owner','none',url)).toBeUndefined();
    jars.reset('owner','alice',url);expect(jars.header('owner','alice',url)).toBeUndefined();
  });
  it('honours path boundaries, default path, Secure and domain matching', () => {
    const jars=new HttpSessions();
    jars.store('owner','default',url,cookies('scoped=one','all=two; Path=/; Secure','bad=third; Domain=evil.example'));
    expect(jars.header('owner','default',url)).toBe('scoped=one; all=two');
    expect(jars.header('owner','default',new URL('https://example.com/apple'))).toBe('all=two');
    expect(jars.header('owner','default',new URL('https://example.com/other'))).toBe('all=two');
    const http=new URL('http://example.com/app/login');
    expect(jars.store('owner','default',http,cookies('secure=no; Secure'))).toBe(1);
    expect(jars.header('owner','default',http)).toBeUndefined();
    expect(jars.store('owner','default',url,cookies('__Host-bad=v; Domain=example.com; Secure; Path=/','__Secure-bad=v'))).toBe(2);
  });
  it('expires, replaces and deletes cookies without replaying a withdrawn login', () => {
    let now=1000;const jars=new HttpSessions(()=>now);
    jars.store('owner','default',url,cookies('sid=one; Path=/; Max-Age=1'));
    expect(jars.header('owner','default',url)).toBe('sid=one');now=2001;
    expect(jars.header('owner','default',url)).toBeUndefined();
    jars.store('owner','default',url,cookies('sid=two; Path=/','sid=three; Path=/'));
    expect(jars.header('owner','default',url)).toBe('sid=three');
    jars.store('owner','default',url,cookies('sid=; Path=/; Max-Age=0'));
    expect(jars.header('owner','default',url)).toBeUndefined();jars.clear();
  });
  it('bounds the jar and session count, including non-ASCII bytes', () => {
    const jars=new HttpSessions();
    expect(jars.store('owner','full',url,cookies(...Array.from({length:65},(_,i)=>`k${i}=v; Path=/`)))).toBe(1);
    expect(jars.header('owner','full',url)!.split('; ')).toHaveLength(64);
    expect(jars.store('owner','bytes',url,cookies('a='+ 'v'.repeat(4096)+'; Path=/','b='+ 'v'.repeat(4096)+'; Path=/'))).toBe(1);
    expect(jars.store('owner','utf8',url,cookies('a='+ 'é'.repeat(3000)+'; Path=/'))).toBe(1);
    for(let i=0;i<62;i++) jars.store('owner',`s${i}`,url,cookies('c=v; Path=/'));
    expect(jars.store('owner','overflow',url,cookies('c=v; Path=/'))).toBe(1);
    jars.clear();expect(jars.header('owner','full',url)).toBeUndefined();
  });
});
