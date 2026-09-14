const todos = [];
const form = document.getElementById('add-form');
const input = document.getElementById('todo-input');
const list = document.getElementById('todo-list');

function render() {
  list.innerHTML = '';
  for (const todo of todos) {
    const li = document.createElement('li');
    li.textContent = todo.title;
    list.appendChild(li);
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const title = input.value.trim();
  if (!title) return;
  todos.push({ title });
  input.value = '';
  render();
});
