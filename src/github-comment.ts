import {readFile} from "node:fs/promises";

export const commentMarker="<!-- wcagc-check -->";
type EventShape={pull_request?:{number?:number;head?:{repo?:{full_name?:string}}};number?:number};
type Comment={id:number;body?:string|null};

export interface CommentContext {repository:string;pullRequest:number;fork:boolean}

export async function githubCommentContext(env:NodeJS.ProcessEnv):Promise<CommentContext|null>{
 if(!env.GITHUB_REPOSITORY||!env.GITHUB_EVENT_PATH)return null;
 let event:EventShape;try{event=JSON.parse(await readFile(env.GITHUB_EVENT_PATH,"utf8")) as EventShape;}catch{return null;}
 const pullRequest=event.pull_request?.number??event.number;if(!pullRequest)return null;
 const head=event.pull_request?.head?.repo?.full_name;
 return {repository:env.GITHUB_REPOSITORY,pullRequest,fork:Boolean(head&&head!==env.GITHUB_REPOSITORY)};
}

export async function upsertPrComment(context:CommentContext,token:string,body:string,fetcher:typeof fetch=fetch):Promise<"created"|"updated">{
 const base=`https://api.github.com/repos/${context.repository}`;
 const headers={accept:"application/vnd.github+json",authorization:`Bearer ${token}`,"content-type":"application/json","x-github-api-version":"2022-11-28"};
 const list=await fetcher(`${base}/issues/${context.pullRequest}/comments?per_page=100`,{headers});
 if(!list.ok)throw new Error(`GitHub comment lookup returned ${list.status}.`);
 const existing=((await list.json()) as Comment[]).find(comment=>comment.body?.includes(commentMarker));
 const response=existing
  ?await fetcher(`${base}/issues/comments/${existing.id}`,{method:"PATCH",headers,body:JSON.stringify({body})})
  :await fetcher(`${base}/issues/${context.pullRequest}/comments`,{method:"POST",headers,body:JSON.stringify({body})});
 if(!response.ok)throw new Error(`GitHub comment write returned ${response.status}.`);
 return existing?"updated":"created";
}
