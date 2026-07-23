# Shadow Stock Pi with an atomic managed dispatcher

A Managed Installation claims the normal `pi` command only through an explicitly enabled, manager-owned dispatcher in a PATH-preferred directory; it never replaces a launcher owned by npm, mise, Homebrew, or another Stock Pi installer. The stable stage-0 dispatcher selects one versioned Manager Release and Downstream Release pair through an atomic activation record, preserving Stock Pi and the previous verified pair as separate recovery paths. This costs an extra dispatch layer and requires strict PATH/collision checks, but avoids corrupting another package manager's state and makes interrupted update, rollback, disablement, and uninstall fail closed.

## Considered Options

Replacing or backing up Stock Pi in place was rejected because ownership and restoration semantics differ across package/version managers. A direct symlink to a release was rejected because update policy and manager compatibility would remain coupled to whichever release happened to be active.
