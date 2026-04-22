# The almost finished story of almost finished chat app

## 1. How was the whole process organized.

As one can easily see I was using Claude Code. I prepared workspace on Sunday (FE + BE developer subagents, CLAUDE.md, other configs, initiating of apps). On Monday, after reading documentation I transformed it to txt and asked Claude to split the whole implementation in rounds and asked to ask follow up questions. After Q&A session it created *master_plan.md* with list of rounds and brief description of each. 

There implementation was done by orchestrator (launced in main agent), FE and BE devs. Later FE tester was added. Initially there were two commands /plan-round (that creates tasks for orchestrator, FE and BE) and /implement-round (that implements tasks and briefly describes work that was done for next rounds). During implementation orchestrator created/modified shared types and API contract description and after that FE and BE work in parallel independently from each other. Later testing (with PlaywrightMCP) was taken out of FE dev responsibility (see bellow why). Next rounds use previous rounds artifacts as a summary of context.

 Only the orchestrator touches `shared/` (API contracts & types); FE and BE devs are forbidden to. This is what made parallel FE+BE work safe — they couldn't race on the contract.

## 2. Some road notes

- Creating "design system" skill (before starting the implementation) to keep UI consistent with angular material was definitylly a right move. 
- I commited & pushed after each round, to be able to rollback. Yes, I'm aware of /rewind, but good old git still looks like something more reliable. 
- Have a lot of troubles fixing login on FE (round 1). I should have made a description of what should login look like (from Angular prospective) and ask Claude to review that, ask follow up questions and prepare detailed document. Probably throwing away the whole Round 1 progress and starting with creating a description of login progress would have given better result.
- After first deveral rounds I tried fixed UI glitches. After that I realized that it just takes much time. Many glitches I noticed looks simillar. Perhaph if I had had more time I would have created a skill on how to use material components properly. 
- After round 2 I've noticed that Claude code starts being essentially less efficient, when context grows greater than 150K. Luckily each /plan-round and /implement-round produces self-sufficient artifacts and I can start with clean context.
- After unsuccessfull attempt to pass through round 2 and 3 (initially there were 5 rounds), decided to split each round into smaller parts, which was a right descision! Instead of 5 rounds I got 12. Maybe I should have split even more.
- After fixing bugs found in some round I noticed that FE developer is stuck (context was greater than 200K, I didn't cleared context after the implementation that time), stopped it and launched with clear context. Cause I had bugs reported in bugs.md and work summary, FE agent with clear context was able to fix bugs. Sometimes I even cleared context between planning and implementation.
- After rounds 5 and 6 I had to spend essential ammount of time working on configs. After round 6 I added frontend-tester subagent. Why? PlaywrightMCP adds huuuuuge amount of stuff in context! After QA round done in FE dev subagent there could be more than 200K. As I said fixing bugs after that is extremely uneffective! After round 6 I told FE dev to write code only, check that it's buildable, produce all the artifacts and than stop. Then frontend-tester steps in, reports bug and those are tried to be fixed by a FE dev with a clear context (see `/fix-bugs` command). 
- After round 7 I understood that deligating testing to a separate subagent was definitelly a good move. However, there's another issue. Playwright MCP still eats a huge amount of tokens. I'm getting closer to hit the current limit. Tried to switch QA to Sonnet (instead of more expensive Opus). QA agent has instructions from FE, so it's not going to do any "smart" work. Cheaper model was OK!
- `bugs.md` is the hand-off between tester and a fresh-context FE dev — same pattern as `_work_summary.md` between rounds, just at bug-fix granularity.
- Yet the closer I got to the finish line the faster I hit Claude's current session usage limit. Claude had more things to push in the context. I need to think what to do with that. Maybe it's possible to do implementation (not planning!) with Sonnet instead of Opus.

Eventually, I hit limit for the last time while implementing round 10. Round 12 was implemented before (cause it was easy and I was sure I wount hit the limit while implementing it). So, rounds 10 and 11 are not implemented.

## PS

1. Yes, I know that's not about vibe-coding, but I think that I should have paid more attention to overall architecture of application. Maybe I should have designed some sort of technical master-plan alongside with business master-plan. I had a quick review of FE. Architecture is chaotic basically. For that reason Claude tried to push everything in context. Proper module partition will help to mitigate issues with context growing fast.

2. I need to find a better solution of UI testing. Playwright MCP consumes tokens desperatelly. 

3. I should try to use Sonnet instead of Opus for implementation.

4. I should think of what skill might have helped me.

I implemented hook to log my prompts to Claude. But looks like it didn't worked properly. There some large prompts in 'prompts' folder if that is interesting.