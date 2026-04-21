We need to do something to FE developer! It works too long. Context grows large (more than 150K or even 200K) and it starts lagging baddly.

How do you think we can make context smaller?

What I suggest is that... 
1. on Phase 2 of implement-round the FE developer only implements the feature and without testing it wrights summary. After that agent is dismissed.
2. After that tester agent using playwright MCP and basing on agents artifacts tests round, fing bugs and reports them in bugs.md.
3. After that I review the list and tell FE developer (with clear context!) to fix some bugs from the list. This time FE developer is allowed to verify its work with Playwright MCP. 

What do you think about that? Feel free to suugest and ask questions.

**Important!** Be consise, you're using too many redundand words in configs.