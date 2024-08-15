# GUIDE FOR THE TYPESCRIPT LANGUAGE

Here we need to the describe the set of typescript we will be using (only functional). and examples of the structure of the code (since well use the kind2 dir and file structure);

# TypeScript project structure

Since the subset of typescript described above is simple, we will use the following pattern.o

### Top-Level Function

Every .ts file must define ONE top-level function:

```typescript
function (arg0: typ0, arg1: typ1): ret_type {
  body
}
```

Where:
- arg0, arg1... are the function arguments
- ret_typ is the returned type
- body is the function's body

### Top-Level Datatype

Alternatively, a .ts file can also define a datatype. Example:

```typescript
type HTerm
  = { $: "Lam", bod: (x: HTerm) => HTerm }
  | { $: "App", fun: HTerm, arg: HTerm }
  | { $: "Var", nam: string }
```

ADTs must follow this convention:
- Constructors represented as objects
- The '$' field is used for the constructor name
- Other fields are the constructor fields
