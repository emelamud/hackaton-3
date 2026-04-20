So, we're builng a chat app! In the root you'll find requirements.docx. It hold requirements to the app. Let's plan?

1. What do I need to add to stack description? Probably I'll need sockets library. Probably I'll need somethig for DB migrations. I want jwt-based authentication. As far as i understand it works well with socker. I don't want to overload root CLAUDE.md. It's better to put FE/BE specific stuff to a CLAUDE.md in frontend/beckend folders or to put info in agent descriptions. Let me know what you think would be the best options.

2. Let's have master plan. All related to plans should be in 'plans' folder. I want the whole process be sprit into **rounds**. After each round I want to have releasable app. Each round contain tasks for FE dev, BE dev and orcestrator (you should somehow mark to whom the task is assigned). Orcestrator just modifies shared folder (i.e. API contracts and types, including response/request types and shared data types). Master plan contains just a list of rounds with a list of tasks inside of each of them. Then for each round I want `round N` folder containing 3 .md documents with detailed description of tasks for orcestrator, BE and FE.

3. Would it make sense to ask FE, BE and orcestrator, briefly describe job that was done during the round? I think that will serve well as a compacted context. Or you have a better idea?

Please feel free to ask follow up questions relentlesly! And yes, please be concise!