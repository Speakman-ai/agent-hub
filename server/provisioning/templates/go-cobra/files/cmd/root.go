// Package cmd wires the cobra command tree for the starter CLI.
package cmd

import (
	"fmt"
	"io"

	"github.com/spf13/cobra"
)

// Hello returns the canonical greeting for the given name. Exposed so tests
// can exercise the greeting independent of cobra plumbing.
func Hello(name string) string {
	if name == "" {
		name = "world"
	}
	return fmt.Sprintf("Hello, %s!", name)
}

// NewRootCommand builds the root cobra command.
func NewRootCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "starter [name]",
		Short: "Starter CLI — prints a hello greeting",
		Long:  "A minimal Go + cobra starter that prints a hello greeting.",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			name := ""
			if len(args) > 0 {
				name = args[0]
			}
			return print(cmd.OutOrStdout(), name)
		},
	}
}

func print(w io.Writer, name string) error {
	_, err := fmt.Fprintln(w, Hello(name))
	return err
}
