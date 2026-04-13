---
name: kanban
description: >-
  Manage project kanban board — list, create, move, and update task cards.
  TRIGGER when: user mentions "kanban", "board", "cards", "tasks", "backlog",
  "sprint", or asks to track, create, or move work items.
version: 1.0.0
keep-coding-instructions: true
---

# Kanban Board Management

You can manage the project's kanban board to track and organize tasks.

## Available Actions

### List cards
Use the API to list all cards on the board:
```
curl $AGENT_HUB_URL/api/projects/$PROJECT_ID/board/cards
```

### Create a card
```
curl -X POST $AGENT_HUB_URL/api/projects/$PROJECT_ID/board/cards \
  -H "Content-Type: application/json" \
  -d '{"title": "Task title", "description": "Details", "priority": "high", "columnId": "todo-column-id"}'
```

### Move a card
```
curl -X POST $AGENT_HUB_URL/api/projects/$PROJECT_ID/board/cards/$CARD_ID/move \
  -H "Content-Type: application/json" \
  -d '{"columnId": "target-column-id", "position": 0}'
```

### Update a card
```
curl -X PUT $AGENT_HUB_URL/api/projects/$PROJECT_ID/board/cards/$CARD_ID \
  -H "Content-Type: application/json" \
  -d '{"title": "Updated title", "description": "Updated details", "priority": "medium"}'
```

## Workflow
1. Check the board for "To Do" cards
2. Pick the highest priority card
3. Move it to "In Progress"
4. Do the work
5. Add a comment with your findings/PR link
6. Move to "Review" or "Done"
