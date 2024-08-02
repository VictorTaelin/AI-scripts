# GUIDE FOR THE TYPESCRIPT LANGUAGE

Here we need to the describe the set of typescript we will be using (only functional). and examples of the structure of the code (since well use the kind2 dir and file structure);

# TypeScript project structure

Since the subset of typescript described above is simple, we will use the following pattern.o

### Top-Level Function

Every .ts file must define ONE top-level function:

```
function (arg0: typ0, arg1: typ1): ret_type {
  body
}
```

Where:
- arg0, arg1... are the function arguments
- ret_typ is the returned type
- body is the function's body


### Top-Level Datatype

Alternatively, a .ts file can also define a datatype:

```
type Action
  = { f0c1: t0c1, f1c1: t1c1 }
  | { f0c2: t0c2, f1c2: t1c2 }
```

Where:
- f0c1, f1c1... are fields of the first constructor
- t0c1, t1c1... are types of the fields
- f0c2, f1c2... are fields of the second constructor
- t0c2, t1c2... are types of the fields

### Names, Paths

TODO


## TypeScript UwU Moba Examples














