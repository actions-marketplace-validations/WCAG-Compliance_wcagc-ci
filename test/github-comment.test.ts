import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {commentMarker,githubCommentContext,upsertPrComment} from "../src/github-comment.js";

test("detects a fork pull request from the event payload",async()=>{const dir=await mkdtemp(join(tmpdir(),"wcagc-event-"));try{const path=join(dir,"event.json");await writeFile(path,JSON.stringify({pull_request:{number:42,head:{repo:{full_name:"contributor/fork"}}}}));assert.deepEqual(await githubCommentContext({GITHUB_REPOSITORY:"owner/repo",GITHUB_EVENT_PATH:path}),{repository:"owner/repo",pullRequest:42,fork:true});}finally{await rm(dir,{recursive:true,force:true});}});

test("creates once and updates the marker comment on repeat runs",async()=>{const calls:{url:string;method:string;body?:string}[]=[];let comments:{id:number;body:string}[]=[];const fetcher:typeof fetch=async(input,init)=>{const url=String(input),method=init?.method??"GET",body=init?.body==null?undefined:String(init.body);calls.push({url,method,body});if(method==="GET")return new Response(JSON.stringify(comments),{status:200});if(method==="POST"){comments=[{id:7,body:JSON.parse(String(init?.body)).body}];return new Response("{}",{status:201});}comments=[{id:7,body:JSON.parse(String(init?.body)).body}];return new Response("{}",{status:200});};const context={repository:"owner/repo",pullRequest:9,fork:false};assert.equal(await upsertPrComment(context,"token",`${commentMarker}\nfirst`,fetcher),"created");assert.equal(await upsertPrComment(context,"token",`${commentMarker}\nsecond`,fetcher),"updated");assert.deepEqual(calls.filter(call=>call.method!=="GET").map(call=>call.method),["POST","PATCH"]);assert.match(comments[0].body,/second/);});

test("surfaces permission denial for the caller to convert into a quiet skip",async()=>{await assert.rejects(()=>upsertPrComment({repository:"owner/repo",pullRequest:1,fork:false},"read-only","body",async()=>new Response("forbidden",{status:403})),/returned 403/);});
